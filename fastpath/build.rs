// Compiles proto/shreder.proto without needing protoc installed.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let fds = protox::compile(["proto/shreder.proto"], ["proto"])?;
    tonic_build::configure().build_server(true).build_client(true).compile_fds(fds)?;
    println!("cargo:rerun-if-changed=proto/shreder.proto");
    Ok(())
}
