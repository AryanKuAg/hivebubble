// Hivebubble Mac app: a thin window around @hivebubble/core.
//
// The app picks a project folder, keeps the Anthropic API key in the macOS
// Keychain, and runs the Node engine (`hivebubble --json`) as a child process.
// Engine events arrive as JSON lines on stdout and are forwarded to the window.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const KEYCHAIN_SERVICE: &str = "dev.hivebubble.desktop";
const KEYCHAIN_ACCOUNT: &str = "anthropic-api-key";
const MAX_RECENT: usize = 8;

struct Running {
    child: Child,
    stdin: Option<ChildStdin>,
    project: String,
}

#[derive(Default)]
struct AppState {
    running: Mutex<Option<Running>>,
}

#[derive(Serialize)]
struct Settings {
    has_key: bool,
    recent: Vec<String>,
    node: Option<String>,
    core: String,
    core_found: bool,
    running: Option<String>,
    example: Option<String>,
    /// Which hosting accounts are connected (no secrets).
    hosts: serde_json::Value,
}

fn key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())
}

fn stored_key() -> Option<String> {
    key_entry().ok()?.get_password().ok().filter(|k| !k.trim().is_empty())
}

/// Hosting accounts for the deploy wizard: one Keychain item per host. The
/// engine gets them as the environment variables each host's API expects.
const HOSTS: [(&str, &[&str]); 3] = [
    ("vercel", &["VERCEL_TOKEN"]),
    ("netlify", &["NETLIFY_AUTH_TOKEN"]),
    ("cloudflare", &["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]),
];

fn host_entry(host: &str) -> Result<keyring::Entry, String> {
    if !HOSTS.iter().any(|(h, _)| *h == host) {
        return Err(format!("Unknown host: {host}"));
    }
    keyring::Entry::new(KEYCHAIN_SERVICE, &format!("host-{host}")).map_err(|e| e.to_string())
}

/// The saved values for a host, in the order of its environment variables.
fn host_values(host: &str) -> Option<Vec<String>> {
    let raw = host_entry(host).ok()?.get_password().ok()?;
    let values: Vec<String> = serde_json::from_str(&raw).ok()?;
    let (_, vars) = HOSTS.iter().find(|(h, _)| *h == host)?;
    (values.len() == vars.len() && values.iter().all(|v| !v.trim().is_empty())).then_some(values)
}

#[tauri::command]
fn save_host_token(host: String, token: String, account_id: Option<String>) -> Result<(), String> {
    let token = token.trim().to_string();
    if token.len() < 8 || token.len() > 512 || token.chars().any(char::is_whitespace) {
        return Err("That doesn't look like a token. Copy it again from the host's token page.".into());
    }
    let mut values = vec![token];
    if host == "cloudflare" {
        let account = account_id.unwrap_or_default().trim().to_lowercase();
        if account.len() != 32 || !account.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("A Cloudflare account ID is 32 letters and digits. Copy it from the Workers & Pages overview.".into());
        }
        values.push(account);
    }
    let json = serde_json::to_string(&values).map_err(|e| e.to_string())?;
    host_entry(&host)?.set_password(&json).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_host_token(host: String) -> Result<(), String> {
    match host_entry(&host)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// A project's database connection string for Users & Data: one Keychain item
/// per project folder. The engine gets it as HIVEBUBBLE_DATABASE_URL.
fn db_entry(project: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &format!("db:{project}")).map_err(|e| e.to_string())
}

fn db_url(project: &str) -> Option<String> {
    db_entry(project).ok()?.get_password().ok().filter(|u| !u.trim().is_empty())
}

#[tauri::command]
fn save_db_url(project: String, url: String) -> Result<(), String> {
    let url = url.trim();
    let scheme = url.starts_with("postgres://") || url.starts_with("postgresql://");
    if !scheme || url.len() > 2048 || url.chars().any(char::is_whitespace) {
        return Err("A connection string starts with postgres:// or postgresql://. Copy it again from your database's dashboard.".into());
    }
    if url.contains("[YOUR-PASSWORD]") {
        return Err("Put your database password in place of [YOUR-PASSWORD] first.".into());
    }
    db_entry(&project)?.set_password(url).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_db_url(project: String) -> Result<(), String> {
    match db_entry(&project)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn has_db_url(project: String) -> bool {
    db_url(&project).is_some()
}

/// Apps opened from Finder don't get the shell's PATH, so ask the login shell
/// once. That finds node and npm wherever they were installed (Homebrew, nvm, …).
fn login_path() -> String {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let output = Command::new(shell)
        .args(["-ilc", "printf '__HB_PATH__%s' \"$PATH\""])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    let fallback = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".to_string();
    match output {
        Ok(out) => String::from_utf8_lossy(&out.stdout)
            .rsplit("__HB_PATH__")
            .next()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .map(|p| format!("{p}:{fallback}"))
            .unwrap_or(fallback),
        Err(_) => fallback,
    }
}

fn find_node(path: &str) -> Option<String> {
    path.split(':')
        .map(|dir| Path::new(dir).join("node"))
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

fn repo_root() -> PathBuf {
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    here.canonicalize().unwrap_or(here)
}

/// v0.1 runs the engine from the repository checkout. A bundled Node runtime
/// and engine come with the packaged app in v0.2.
fn core_script() -> PathBuf {
    std::env::var("HIVEBUBBLE_CORE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| repo_root().join("packages/core/dist/cli.js"))
}

fn recent_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("recent.json"))
}

fn load_recent(app: &AppHandle) -> Vec<String> {
    recent_file(app)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|p| Path::new(p).join("package.json").is_file())
        .collect()
}

fn remember_recent(app: &AppHandle, project: &str) {
    let mut recent = load_recent(app);
    recent.retain(|p| p != project);
    recent.insert(0, project.to_string());
    recent.truncate(MAX_RECENT);
    if let (Some(file), Ok(json)) = (recent_file(app), serde_json::to_string_pretty(&recent)) {
        let _ = std::fs::write(file, json);
    }
}

/// Close the engine's stdin so it shuts down cleanly (it stops the dev server
/// too), then force it if it takes too long.
fn stop_running(state: &AppState) {
    let taken = state.running.lock().ok().and_then(|mut r| r.take());
    if let Some(mut running) = taken {
        drop(running.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(6);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = running.child.try_wait() {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        let _ = running.child.kill();
        let _ = running.child.wait();
    }
}

#[tauri::command]
fn get_settings(app: AppHandle, state: State<AppState>) -> Settings {
    let path = login_path();
    let core = core_script();
    let example = repo_root().join("examples/vite-react");
    Settings {
        has_key: stored_key().is_some(),
        recent: load_recent(&app),
        node: find_node(&path),
        core_found: core.is_file(),
        core: core.to_string_lossy().into_owned(),
        running: state.running.lock().ok().and_then(|r| r.as_ref().map(|r| r.project.clone())),
        example: example.join("package.json").is_file().then(|| example.to_string_lossy().into_owned()),
        hosts: serde_json::Value::Object(HOSTS.iter().map(|(h, _)| (h.to_string(), serde_json::Value::Bool(host_values(h).is_some()))).collect()),
    }
}

#[tauri::command]
fn save_api_key(key: String) -> Result<(), String> {
    let key = key.trim();
    if !key.starts_with("sk-ant-") {
        return Err("That doesn't look like an Anthropic API key. Keys start with \"sk-ant-\".".into());
    }
    key_entry()?.set_password(key).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_api_key() -> Result<(), String> {
    match key_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Hivebubble's own folder, shared with the engine: the spending ledger and the
/// settings (daily limit, per-task limit). Same rule as the engine's `hivebubbleHome()`.
fn hivebubble_home() -> PathBuf {
    if let Ok(dir) = std::env::var("HIVEBUBBLE_HOME") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    let home = std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."));
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Hivebubble")
    } else {
        home.join(".hivebubble")
    }
}

fn read_json(file: &Path) -> serde_json::Value {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

/// The raw ledger and settings. The window adds the days up itself, so "today"
/// follows the person's own calendar.
#[tauri::command]
fn get_spending() -> serde_json::Value {
    let home = hivebubble_home();
    let ledger = read_json(&home.join("spend.json"));
    serde_json::json!({
        "settings": read_json(&home.join("settings.json")),
        "days": ledger.get("days").cloned().unwrap_or_else(|| serde_json::json!({})),
    })
}

/// Save the daily limit. The engine reads it before every task, so it applies right away.
#[tauri::command]
fn set_daily_cap(usd: f64) -> Result<(), String> {
    if !usd.is_finite() || !(0.5..=10_000.0).contains(&usd) {
        return Err("Choose a daily limit between $0.50 and $10,000.".into());
    }
    let home = hivebubble_home();
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let file = home.join("settings.json");
    let mut settings = read_json(&file);
    if !settings.is_object() {
        settings = serde_json::json!({});
    }
    settings["dailyCapUsd"] = serde_json::json!((usd * 100.0).round() / 100.0);
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    let tmp = home.join("settings.json.tmp");
    std::fs::write(&tmp, format!("{text}\n")).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

#[tauri::command]
async fn pick_folder(app: AppHandle, title: Option<String>) -> Option<String> {
    let title = title.unwrap_or_else(|| "Choose your project folder".into());
    app.dialog().file().set_title(title).blocking_pick_folder().map(|p| p.to_string())
}

/// Run one of the engine's own subcommands (`skills`, `starters`, `new`) with
/// `--json` and return its output. Nothing else can be run through here.
fn engine_cli(args: &[String], cwd: Option<&Path>) -> Result<String, String> {
    let first = args.first().map(String::as_str).unwrap_or("");
    if !matches!(first, "skills" | "starters" | "new") {
        return Err(format!("Not an engine command: {first}"));
    }
    let path = login_path();
    let node = find_node(&path).ok_or("Node.js isn't installed. Install it from nodejs.org, then reopen Hivebubble.")?;
    let core = core_script();
    let mut cmd = Command::new(node);
    cmd.arg(&core).args(args).arg("--json").env("PATH", &path).stdin(Stdio::null());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let out = cmd.output().map_err(|e| format!("Couldn't run the engine: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // Errors come back as {"error": "..."} on stdout.
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&stdout) {
        if let Some(err) = value.get("error").and_then(|e| e.as_str()) {
            return Err(err.to_string());
        }
    }
    if out.status.success() {
        Ok(stdout)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[tauri::command]
fn run_cli(args: Vec<String>) -> Result<String, String> {
    engine_cli(&args, None)
}

/// "Start something new": pick a starter for the request and create the app
/// in a new folder inside `parent`.
#[tauri::command]
fn create_project(parent: String, what: String) -> Result<String, String> {
    let parent = PathBuf::from(&parent);
    if !parent.is_dir() {
        return Err("Choose an existing folder to create the app in.".into());
    }
    engine_cli(&["new".to_string(), "--for".to_string(), what], Some(&parent))
}

/// Skills link to their files on GitHub; nothing else opens from here.
#[tauri::command]
fn open_link(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/") {
        return Err("Hivebubble only opens GitHub links here.".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn start_project(app: AppHandle, state: State<AppState>, project: String, demo: bool, prompt: Option<String>) -> Result<(), String> {
    stop_running(&state);
    if !Path::new(&project).join("package.json").is_file() {
        return Err("That folder has no package.json. Choose the folder of a JavaScript web project.".into());
    }
    let path = login_path();
    let node = find_node(&path).ok_or("Node.js isn't installed. Install it from nodejs.org, then reopen Hivebubble.")?;
    let core = core_script();
    if !core.is_file() {
        return Err(format!("The Hivebubble engine isn't built yet. Run `pnpm build` in {}.", repo_root().display()));
    }

    let mut cmd = Command::new(node);
    cmd.arg(&core)
        .arg(&project)
        .args(["--json", "--no-open", "--exit-with-stdin"])
        .env("PATH", &path)
        .env_remove("ANTHROPIC_API_KEY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if demo {
        cmd.arg("--mock-agent");
    } else if let Some(key) = stored_key() {
        cmd.env("ANTHROPIC_API_KEY", key);
    }
    if let Some(prompt) = prompt.filter(|p| !p.trim().is_empty()) {
        cmd.arg("--prompt").arg(prompt);
    }
    // The bubble tells people to save connection strings here, not in a file.
    cmd.env("HIVEBUBBLE_APP", "1").env_remove("HIVEBUBBLE_DATABASE_URL");
    if let Some(url) = db_url(&project) {
        cmd.env("HIVEBUBBLE_DATABASE_URL", url);
    }
    // Hosting accounts from the Keychain, for the deploy wizard.
    for (host, vars) in HOSTS {
        for var in vars {
            cmd.env_remove(var);
        }
        if let Some(values) = host_values(host) {
            for (var, value) in vars.iter().zip(values) {
                cmd.env(var, value);
            }
        }
    }
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start the engine: {e}"))?;

    if let Some(stdout) = child.stdout.take() {
        let app = app.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = app.emit("core-event", line);
            }
            let _ = app.emit("core-exit", ());
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let event = serde_json::json!({ "event": "log", "source": "hivebubble", "line": line });
                let _ = app.emit("core-event", event.to_string());
            }
        });
    }

    let stdin = child.stdin.take();
    if let Ok(mut running) = state.running.lock() {
        *running = Some(Running { child, stdin, project: project.clone() });
    }
    remember_recent(&app, &project);
    Ok(())
}

#[tauri::command]
fn stop_project(state: State<AppState>) {
    stop_running(&state);
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("http://localhost:") && !url.starts_with("http://127.0.0.1:") {
        return Err("Hivebubble only opens local preview links.".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Automated check used in development: `HIVEBUBBLE_SELFTEST=1` makes the window
/// start the bundled example in demo mode and report back through `selftest_done`.
#[tauri::command]
fn selftest_enabled() -> bool {
    std::env::var("HIVEBUBBLE_SELFTEST").map(|v| v == "1").unwrap_or(false)
}

#[tauri::command]
fn selftest_done(app: AppHandle, state: State<AppState>, ok: bool, report: String) {
    println!("HIVEBUBBLE_SELFTEST {} {}", if ok { "PASS" } else { "FAIL" }, report);
    stop_running(&state);
    app.exit(if ok { 0 } else { 1 });
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            get_spending,
            set_daily_cap,
            run_cli,
            create_project,
            open_link,
            save_host_token,
            clear_host_token,
            save_db_url,
            clear_db_url,
            has_db_url,
            save_api_key,
            clear_api_key,
            pick_folder,
            start_project,
            stop_project,
            open_url,
            selftest_enabled,
            selftest_done
        ])
        .build(tauri::generate_context!())
        .expect("error while building Hivebubble");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            stop_running(&handle.state::<AppState>());
        }
    });
}
