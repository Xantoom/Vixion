//! Opens the media port on the home router by UPnP, as Plex does: the router forwards the public
//! port to this machine without anyone setting it up by hand (`VIXION_UPNP`).
//!
//! The router is found by SSDP, its description read for the WAN connection service, and the
//! mapping asked for with a lease that is renewed well before it runs out. It is removed when the
//! process stops. Discovery needs the router's multicast: in Docker, host networking.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use tokio::net::UdpSocket;
use tokio::sync::broadcast;

use crate::alerts::Level;
use crate::app::AppState;

const SSDP: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(239, 255, 255, 250)), 1900);
const SERVICES: [&str; 3] = [
    "urn:schemas-upnp-org:service:WANIPConnection:2",
    "urn:schemas-upnp-org:service:WANIPConnection:1",
    "urn:schemas-upnp-org:service:WANPPPConnection:1",
];
/// Asked for an hour, renewed every twenty minutes: a router that restarts gets it back soon.
const LEASE: u32 = 3600;
const RENEW: Duration = Duration::from_secs(20 * 60);
const RETRY: Duration = Duration::from_secs(5 * 60);

/// The router's WAN connection service.
struct Gateway {
    control: String,
    service: &'static str,
    /// This machine's address on the router's network.
    local: IpAddr,
}

/// Keeps the media port forwarded until `stop`, then removes the mapping.
pub async fn run(app: AppState, mut stop: broadcast::Receiver<()>) {
    let public = app.config.media_public_port;
    let internal = app.config.media_addr.port();
    let mut mapped: Option<Gateway> = None;
    loop {
        let result = async {
            let gateway = match mapped.take() {
                Some(gateway) => gateway,
                None => discover(&app.http).await?,
            };
            add(&app.http, &gateway, public, internal).await?;
            Ok::<_, String>(gateway)
        }
        .await;
        let wait = match result {
            Ok(gateway) => {
                let address = external_ip(&app.http, &gateway).await.unwrap_or_default();
                tracing::info!(public, internal, local = %gateway.local, address, "media port opened by UPnP");
                app.alerts.resolve("upnp").await;
                mapped = Some(gateway);
                RENEW
            }
            Err(error) => {
                tracing::warn!(%error, "UPnP: can't open the media port");
                app.alerts
                    .raise(Level::Warning, "upnp", format!("The router didn't open port {public} by UPnP: {error}"))
                    .await;
                RETRY
            }
        };
        tokio::select! {
            () = tokio::time::sleep(wait) => {}
            _ = stop.recv() => break,
        }
    }
    if let Some(gateway) = mapped {
        match remove(&app.http, &gateway, public).await {
            Ok(()) => tracing::info!(public, "media port closed by UPnP"),
            Err(error) => tracing::warn!(%error, "UPnP: can't close the media port"),
        }
    }
}

/// Finds the router by SSDP and reads where its WAN connection service answers.
async fn discover(http: &reqwest::Client) -> Result<Gateway, String> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).await.map_err(|e| e.to_string())?;
    let search = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\n\
                  ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n";
    socket.send_to(search.as_bytes(), SSDP).await.map_err(|e| e.to_string())?;
    let mut buffer = [0u8; 2048];
    let (length, from) = tokio::time::timeout(Duration::from_secs(4), socket.recv_from(&mut buffer))
        .await
        .map_err(|_| "no router answered (UPnP off, or not on the host network)".to_owned())?
        .map_err(|e| e.to_string())?;
    let answer = String::from_utf8_lossy(&buffer[..length]);
    let location = header(&answer, "location").ok_or("the router gave no description")?;
    let base = reqwest::Url::parse(location).map_err(|e| e.to_string())?;
    let description =
        http.get(base.clone()).send().await.map_err(|e| e.to_string())?.text().await.map_err(|e| e.to_string())?;
    let (service, control) = SERVICES
        .iter()
        .find_map(|service| control_url(&description, service).map(|control| (*service, control)))
        .ok_or("the router has no WAN connection service")?;
    let control = base.join(&control).map_err(|e| e.to_string())?.to_string();
    // The address the router reaches this machine on: the one used to talk to it.
    let probe = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|e| e.to_string())?;
    probe.connect(from).map_err(|e| e.to_string())?;
    let local = probe.local_addr().map_err(|e| e.to_string())?.ip();
    Ok(Gateway { control, service, local })
}

async fn add(http: &reqwest::Client, gateway: &Gateway, public: u16, internal: u16) -> Result<(), String> {
    let mapping = |lease: u32| {
        format!(
            "<NewRemoteHost></NewRemoteHost><NewExternalPort>{public}</NewExternalPort><NewProtocol>TCP</NewProtocol>\
             <NewInternalPort>{internal}</NewInternalPort><NewInternalClient>{}</NewInternalClient>\
             <NewEnabled>1</NewEnabled><NewPortMappingDescription>Vixion</NewPortMappingDescription>\
             <NewLeaseDuration>{lease}</NewLeaseDuration>",
            gateway.local
        )
    };
    match soap(http, gateway, "AddPortMapping", &mapping(LEASE)).await {
        // Some routers only take mappings that never expire.
        Err(error) if error.contains("725") => soap(http, gateway, "AddPortMapping", &mapping(0)).await.map(drop),
        other => other.map(drop),
    }
}

async fn remove(http: &reqwest::Client, gateway: &Gateway, public: u16) -> Result<(), String> {
    let args = format!(
        "<NewRemoteHost></NewRemoteHost><NewExternalPort>{public}</NewExternalPort><NewProtocol>TCP</NewProtocol>"
    );
    soap(http, gateway, "DeletePortMapping", &args).await.map(drop)
}

async fn external_ip(http: &reqwest::Client, gateway: &Gateway) -> Option<String> {
    let answer = soap(http, gateway, "GetExternalIPAddress", "").await.ok()?;
    tag(&answer, "NewExternalIPAddress").map(str::to_owned)
}

/// Calls an action of the router's service; its answer, or its error code and words.
async fn soap(http: &reqwest::Client, gateway: &Gateway, action: &str, args: &str) -> Result<String, String> {
    let body = format!(
        "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" \
         s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body>\
         <u:{action} xmlns:u=\"{service}\">{args}</u:{action}></s:Body></s:Envelope>",
        service = gateway.service
    );
    let response = http
        .post(&gateway.control)
        .header("Content-Type", "text/xml; charset=\"utf-8\"")
        .header("SOAPAction", format!("\"{}#{action}\"", gateway.service))
        .body(body)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let ok = response.status().is_success();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if ok {
        return Ok(text);
    }
    Err(match (tag(&text, "errorCode"), tag(&text, "errorDescription")) {
        (Some(code), Some(words)) => format!("error {code}, {words}"),
        (Some(code), None) => format!("error {code}"),
        _ => "the router refused".to_owned(),
    })
}

/// A header of an SSDP answer, by name in any case.
fn header<'a>(answer: &'a str, name: &str) -> Option<&'a str> {
    answer.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

/// The text of the first `<name>` element, whatever its namespace prefix.
fn tag<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let open = xml.find(&format!("{name}>"))? + name.len() + 1;
    let close = open + xml[open..].find("</")?;
    Some(xml[open..close].trim())
}

/// Where a service of the description takes its actions.
fn control_url(description: &str, service: &str) -> Option<String> {
    let at = description.find(&format!("<serviceType>{service}</serviceType>"))?;
    let rest = &description[at..];
    let end = rest.find("</service>").unwrap_or(rest.len());
    tag(&rest[..end], "controlURL").map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_ssdp_answer() {
        let answer =
            "HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=120\r\nLocation: http://192.168.1.1:43467/rootDesc.xml\r\n\r\n";
        assert_eq!(header(answer, "LOCATION"), Some("http://192.168.1.1:43467/rootDesc.xml"));
    }

    #[test]
    fn finds_the_wan_service_control() {
        let description = "<service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType>\
            <controlURL>/ctl/L3F</controlURL></service><service>\
            <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>\
            <controlURL>/ctl/IPConn</controlURL></service>";
        assert_eq!(control_url(description, SERVICES[1]).as_deref(), Some("/ctl/IPConn"));
        assert_eq!(control_url(description, SERVICES[0]), None);
    }

    #[test]
    fn reads_soap_answers() {
        let answer = "<s:Body><u:GetExternalIPAddressResponse><NewExternalIPAddress>203.0.113.7</NewExternalIPAddress>";
        assert_eq!(tag(answer, "NewExternalIPAddress"), Some("203.0.113.7"));
        let fault =
            "<UPnPError><errorCode>725</errorCode><errorDescription>OnlyPermanentLeasesSupported</errorDescription>";
        assert_eq!(tag(fault, "errorCode"), Some("725"));
    }
}
