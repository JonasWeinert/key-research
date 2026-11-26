// Compiles connectors/specs/*.json into the binary as the baseline bundle, so database
// search works offline and before any update was downloaded.
use std::path::Path;

fn main() {
    let specs = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../connectors/specs");
    println!("cargo:rerun-if-changed={}", specs.display());
    let mut names: Vec<String> = std::fs::read_dir(&specs)
        .map(|dir| dir.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).map(|p| p.display().to_string()).collect())
        .unwrap_or_default();
    names.sort();
    let mut out = String::from("pub const BASELINE: &[(&str, &str)] = &[\n");
    for name in &names {
        println!("cargo:rerun-if-changed={name}");
        let file = Path::new(name).file_name().and_then(|f| f.to_str()).unwrap_or_default();
        out.push_str(&format!("    ({file:?}, include_str!({name:?})),\n"));
    }
    out.push_str("];\n");
    let dest = Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR")).join("baseline.rs");
    std::fs::write(dest, out).expect("write baseline.rs");
}
