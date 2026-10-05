//! The link with the Node bot: one local TCP connection (127.0.0.1 only),
//! one JSON object per line each way.

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

pub struct Link {
    /// Messages to the Node bot (dropped while it isn't connected).
    pub out: UnboundedSender<Value>,
    /// Is the Node bot connected? (Nothing is queued for it while it isn't.)
    pub connected: Arc<AtomicBool>,
}

/// What a new connection gets first: the hello (with the feeds' current
/// states), then the buys the Node bot hasn't acknowledged yet.
pub type Greeting = std::sync::Arc<dyn Fn() -> (Value, Vec<Value>) + Send + Sync>;

/// Listen on 127.0.0.1:`port`. Incoming messages go to `inbox`. Returns the
/// outgoing side. Messages queued while nobody was connected are dropped,
/// except the unacknowledged buys, which the greeting resends.
pub async fn serve(port: u16, inbox: UnboundedSender<Value>, greeting: Greeting) -> std::io::Result<Link> {
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    let (out_tx, out_rx) = unbounded_channel::<Value>();
    let out_rx = std::sync::Arc::new(tokio::sync::Mutex::new(out_rx));
    let connected = Arc::new(AtomicBool::new(false));
    let conn = connected.clone();
    tokio::spawn(async move {
        loop {
            let sock = match listener.accept().await {
                Ok((sock, _)) => sock,
                Err(e) => {
                    // e.g. out of file descriptors: don't spin.
                    crate::log(&format!("Couldn't accept a connection: {e}"));
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    continue;
                }
            };
            let _ = sock.set_nodelay(true);
            crate::log("The Node bot connected.");
            let (rd, mut wr) = sock.into_split();
            let inbox = inbox.clone();
            let out_rx = out_rx.clone();
            let greeting = greeting.clone();
            conn.store(true, Ordering::Release);
            // Only one connection is served at a time: a new one replaces the old.
            let writer = tokio::spawn(async move {
                let mut rx: tokio::sync::MutexGuard<'_, UnboundedReceiver<Value>> = out_rx.lock().await;
                while rx.try_recv().is_ok() {} // nothing stale from before
                let (hello, resend) = greeting();
                for v in std::iter::once(hello).chain(resend) {
                    let mut line = v.to_string();
                    line.push('\n');
                    if wr.write_all(line.as_bytes()).await.is_err() {
                        return;
                    }
                }
                while let Some(v) = rx.recv().await {
                    let mut line = v.to_string();
                    line.push('\n');
                    if wr.write_all(line.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
            let mut lines = BufReader::new(rd).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                if let Ok(v) = serde_json::from_str::<Value>(&l) {
                    let _ = inbox.send(v);
                }
            }
            writer.abort();
            conn.store(false, Ordering::Release);
            let _ = inbox.send(serde_json::json!({ "type": "disconnected" }));
            crate::log("The Node bot disconnected.");
        }
    });
    Ok(Link { out: out_tx, connected })
}
