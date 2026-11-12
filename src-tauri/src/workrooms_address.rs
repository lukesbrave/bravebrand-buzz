#[tauri::command]
pub(crate) async fn workrooms_address_setup(ip: String, slug: String) -> Result<String, String> {
    if !cfg!(target_os = "macos")
        || option_env!("VITE_BRAVEBRAND_MANAGED_ADDRESS") != Some("true")
        || !buzz_credential_store::BRAVEBRAND_REHEARSAL
    {
        return Err("Managed setup is unavailable in this build.".into());
    }
    let ipv4 = ip
        .parse::<std::net::Ipv4Addr>()
        .map_err(|_| "Enter the public IPv4 from Hetzner.")?;
    if ipv4.is_private()
        || ipv4.is_loopback()
        || ipv4.is_link_local()
        || ipv4.is_multicast()
        || ipv4.is_documentation()
        || !(1..224).contains(&ipv4.octets()[0])
    {
        return Err("Enter the public IPv4 from Hetzner.".into());
    }
    let label = slug.as_bytes();
    if !(2..=40).contains(&label.len())
        || !label[0].is_ascii_lowercase()
        || label.last() == Some(&b'-')
        || !label
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
    {
        return Err(
            "Use 2–40 lowercase letters, numbers or hyphens, starting with a letter.".into(),
        );
    }
    tauri::async_runtime::spawn_blocking(move || run(ipv4, &slug))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(unix)]
fn run(ip: std::net::Ipv4Addr, slug: &str) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    const SCRIPT: &str = include_str!("../../scripts/workrooms/setup/install.py");
    let files = serde_json::json!({
        "compose.yml": include_str!("../../scripts/workrooms/setup/compose.yml"),
        "Caddyfile": include_str!("../../scripts/workrooms/setup/Caddyfile")
    });
    let installer = STANDARD.encode(format!("FILES = {files}\n{SCRIPT}"));
    // Transfer only bundled program text. SSH and the setup program prompt for
    // credentials in Terminal; the renderer never receives either credential.
    let remote = format!("umask 077 && f=$(mktemp) && trap 'rm -f \"$f\"' EXIT && printf %s {installer} | base64 -d > \"$f\" && /usr/bin/python3 \"$f\" {slug} {ip}");
    let temp = tempfile::tempdir().map_err(|_| "Cannot prepare setup.")?;
    let status = temp.path().join("status");
    let key_dir = dirs::home_dir()
        .ok_or("Cannot locate the SSH key folder.")?
        .join(".ssh");
    let key_path = rfd::FileDialog::new()
        .set_title("Choose your VPS SSH key (the file without .pub)")
        .set_directory(key_dir)
        .pick_file()
        .ok_or("SSH key selection was cancelled.")?;
    let key = key_path.to_str().ok_or("Choose a valid SSH key file.")?;
    if !key_path.is_file() || key.ends_with(".pub") {
        return Err("Choose the SSH key file without .pub.".into());
    }
    fn quote(text: &str) -> String {
        format!("'{}'", text.replace('\'', "'\\''"))
    }
    let launcher = temp.path().join("Set up Workrooms.command");
    let command = format!(
        "#!/bin/sh\n/usr/bin/ssh -F /dev/null -t -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o PreferredAuthentications=publickey -o ConnectTimeout=20 -i {} root@{} {}\ncode=$?\nprintf '%s\\n' \"$code\" > {}\nexit \"$code\"\n",
        quote(key), ip, quote(&remote), quote(&status.to_string_lossy())
    );
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(&launcher, command).map_err(|_| "Could not prepare SSH setup.")?;
    std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700))
        .map_err(|_| "Could not prepare SSH setup.")?;
    let opened = std::process::Command::new("/usr/bin/open")
        .args(["-a", "Terminal"])
        .arg(launcher)
        .status()
        .map_err(|_| "Could not open Terminal.")?;
    if !opened.success() {
        return Err("Could not open Terminal.".into());
    }
    let start = std::time::Instant::now();
    loop {
        if let Ok(code) = std::fs::read_to_string(&status) {
            if code.trim() == "0" {
                break;
            }
            if !code.is_empty() {
                return Err("Check the setup message in Terminal and retry.".into());
            }
        }
        if start.elapsed().as_secs() >= 1800 {
            return Err("Setup timed out. Check Terminal before retrying.".into());
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    Ok(format!("https://{slug}.workrooms.bravebrand.com"))
}

#[cfg(not(unix))]
fn run(_: std::net::Ipv4Addr, _: &str) -> Result<String, String> {
    Err("Managed setup requires macOS.".into())
}
