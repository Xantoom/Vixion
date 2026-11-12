//! Rebuilds the binary when the interface is rebuilt: it is embedded at compile time.
fn main() {
    println!("cargo:rerun-if-changed=../web/dist");
}
