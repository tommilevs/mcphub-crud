//! Resolve installed JS entrypoints without running or publishing their tools.
use super::installer_jobs::validate_request;
use serde_json::{json, Value};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

// Node's entrypoint resolver rejects Windows verbatim paths with EISDIR. Keep
// canonical paths for containment checks, then export an equivalent launch path.
fn node_launch_path(canonical: &Path) -> Result<PathBuf, &'static str> {
    let text = canonical.to_str().ok_or("installed path is not Unicode")?;
    let normal = if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{unc}"))
    } else if let Some(disk) = text.strip_prefix(r"\\?\") {
        let bytes = disk.as_bytes();
        if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || &bytes[1..3] != b":\\" {
            return Err("installed path namespace is unsupported");
        }
        PathBuf::from(disk)
    } else {
        canonical.to_path_buf()
    };
    if normal
        .canonicalize()
        .map_err(|_| "installed launch path unavailable")?
        != canonical
    {
        return Err("installed launch path changes filesystem identity");
    }
    Ok(normal)
}

fn read_json(path: &Path, root: &Path) -> Result<Value, &'static str> {
    let path = path
        .canonicalize()
        .map_err(|_| "installed metadata is unavailable")?;
    if !path.starts_with(root) || !path.is_file() {
        return Err("installed metadata leaves its owned directory");
    }
    let file = std::fs::File::open(path).map_err(|_| "installed metadata is unavailable")?;
    let mut bytes = Vec::new();
    file.take(1_048_577)
        .read_to_end(&mut bytes)
        .map_err(|_| "installed metadata is unreadable")?;
    if bytes.len() > 1_048_576 {
        return Err("installed metadata exceeds its size limit");
    }
    serde_json::from_slice(&bytes).map_err(|_| "installed metadata is invalid")
}

pub fn resolve(
    id: &str,
    package: &str,
    version: &str,
    runtime: &Path,
    root: &Path,
) -> Result<Value, &'static str> {
    validate_request(id, package, version)?;
    let root = root
        .canonicalize()
        .map_err(|_| "installer staging root unavailable")?;
    let directory = root
        .join(id)
        .canonicalize()
        .map_err(|_| "installer staging unavailable")?;
    if directory == root || !directory.starts_with(&root) {
        return Err("installer staging leaves its owned root");
    }
    let marker = read_json(&directory.join("operation.json"), &directory)?;
    if marker["id"] != id || marker["package"] != package || marker["version"] != version {
        return Err("installed operation identity does not match the plan");
    }
    let package_dir = directory
        .join("node_modules")
        .join(package)
        .canonicalize()
        .map_err(|_| "installed package unavailable")?;
    if !package_dir.starts_with(&directory) {
        return Err("installed package leaves its owned directory");
    }
    let metadata = read_json(&package_dir.join("package.json"), &package_dir)?;
    if metadata["name"] != package || metadata["version"] != version {
        return Err("installed package identity does not match the plan");
    }
    let bin = if let Some(bin) = metadata["bin"].as_str() {
        bin
    } else if let Some(bins) = metadata["bin"].as_object() {
        let selected = if bins.len() == 1 {
            bins.values().next()
        } else {
            bins.get(package.rsplit('/').next().unwrap_or(package))
        };
        selected
            .and_then(Value::as_str)
            .ok_or("installed package has ambiguous executable entries")?
    } else {
        return Err("installed package has no executable entry");
    };
    let executable = package_dir
        .join(bin)
        .canonicalize()
        .map_err(|_| "installed executable unavailable")?;
    if !executable.is_file() || !executable.starts_with(&package_dir) {
        return Err("installed executable leaves its package directory");
    }
    if !matches!(
        executable.extension().and_then(|ext| ext.to_str()),
        None | Some("js" | "cjs" | "mjs")
    ) {
        return Err("installed executable requires an unsupported runtime adapter");
    }
    let node = runtime
        .join("node.exe")
        .canonicalize()
        .map_err(|_| "bundled Node runtime unavailable")?;
    if !node.is_file() {
        return Err("bundled Node runtime unavailable");
    }
    let node = node_launch_path(&node)?;
    let executable = node_launch_path(&executable)?;
    let directory = node_launch_path(&directory)?;
    Ok(
        json!({"verification":"package_metadata","package":{"name":package,"version":version},
      "spec":{"id":format!("acquisition-{id}"),"server_name":package,"command":node,"args":[executable],
        "cwd":directory,"env":{},"restart_limit":0}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolves_pinned_entry_and_rejects_identity_escape_and_ambiguous_bins() {
        let temp = std::env::temp_dir();
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = temp.join(format!(
            "mcphub-package-fixture-{}-{nonce}",
            std::process::id()
        ));
        let id = "00000000-0000-4000-8000-000000000002";
        let runtime = root.join("runtime");
        let stages = root.join("acquisitions");
        let directory = stages.join(id);
        let package = directory.join("node_modules/@fixture/mcp");
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(runtime.join("node.exe"), []).unwrap();
        std::fs::write(
            package.join("main.js"),
            "process.stdout.write('node-entry-ok')",
        )
        .unwrap();
        std::fs::write(directory.join("outside.js"), []).unwrap();
        std::fs::write(
            directory.join("operation.json"),
            json!({"id":id,"package":"@fixture/mcp","version":"1.2.3"}).to_string(),
        )
        .unwrap();
        let write = |bin: Value| {
            std::fs::write(
                package.join("package.json"),
                json!({"name":"@fixture/mcp","version":"1.2.3","bin":bin}).to_string(),
            )
            .unwrap()
        };
        write(json!({"mcp":"main.js"}));
        let result = resolve(id, "@fixture/mcp", "1.2.3", &runtime, &stages).unwrap();
        assert_eq!(result["verification"], "package_metadata");
        assert_eq!(result["spec"]["restart_limit"], 0);
        for path in [
            &result["spec"]["command"],
            &result["spec"]["args"][0],
            &result["spec"]["cwd"],
        ] {
            assert!(
                !path.as_str().unwrap().starts_with(r"\\?\"),
                "Node launch paths must not use the verbatim namespace"
            );
        }
        let launched = std::process::Command::new("node.exe")
            .arg(result["spec"]["args"][0].as_str().unwrap())
            .current_dir(result["spec"]["cwd"].as_str().unwrap())
            .output()
            .unwrap();
        assert!(
            launched.status.success(),
            "{}",
            String::from_utf8_lossy(&launched.stderr)
        );
        assert_eq!(launched.stdout, b"node-entry-ok");
        assert!(resolve(id, "@fixture/mcp", "1.2.4", &runtime, &stages).is_err());
        write(json!("../../../outside.js"));
        assert!(resolve(id, "@fixture/mcp", "1.2.3", &runtime, &stages)
            .unwrap_err()
            .contains("leaves"));
        write(json!({"one":"main.js","two":"main.js"}));
        assert!(resolve(id, "@fixture/mcp", "1.2.3", &runtime, &stages)
            .unwrap_err()
            .contains("ambiguous"));
        assert!(root.starts_with(&temp));
        assert!(root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("mcphub-package-fixture-"));
        std::fs::remove_dir_all(&root).unwrap();
        assert!(!root.exists());
    }
}
