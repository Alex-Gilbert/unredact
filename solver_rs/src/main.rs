mod dfs;
mod full_name;
mod word_filter;

use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::{Json, Router, routing::post};
use axum::extract::State;
use axum::response::sse::{Event, Sse};
use dfs::{Constraint, SolveResult, WidthTable, compute_length_bounds, solve_subtree,
          compute_equiv_classes, dedup_state_allowed};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;
use tower_http::cors::CorsLayer;
use word_filter::WordFilter;

// ── Shared state ──

type AppState = Arc<WordFilter>;

// ── Request/Response types ──

#[derive(Deserialize)]
struct SolveRequest {
    charset: String,
    width_table: Vec<f64>,
    left_edge: Vec<f64>,
    right_edge: Vec<f64>,
    target: f64,
    tolerance: f64,
    min_length: Option<usize>,
    max_length: Option<usize>,
    state_allowed: Option<Vec<Vec<usize>>>,
    state_next: Option<Vec<Vec<i32>>>,
    accept_states: Option<Vec<usize>>,
    max_results: Option<usize>,
    #[serde(default = "default_filter")]
    filter: String,
    #[serde(default)]
    filter_prefix: String,
    #[serde(default)]
    filter_suffix: String,
}

#[derive(Deserialize)]
struct FullNameRequest {
    word_charset: String,
    wt1_table: Vec<f64>,
    wt1_left_edge: Vec<f64>,
    wt1_right_edge: Vec<f64>,
    wt2_table: Vec<f64>,
    wt2_right_edge: Vec<f64>,
    space_advance: Vec<f64>,
    left_after_space: Vec<f64>,
    target: f64,
    tolerance: f64,
    uppercase_only: bool,
    max_results: Option<usize>,
    #[serde(default = "default_filter")]
    filter: String,
    #[serde(default)]
    filter_prefix: String,
    #[serde(default)]
    filter_suffix: String,
}

fn default_filter() -> String {
    "none".to_string()
}

#[derive(Serialize)]
struct ResultEntry {
    text: String,
    width: f64,
    error: f64,
}

#[derive(Serialize)]
struct DoneEntry {
    done: bool,
    total: usize,
}

impl From<SolveResult> for ResultEntry {
    fn from(r: SolveResult) -> Self {
        ResultEntry { text: r.text, width: r.width, error: r.error }
    }
}

// ── Handlers ──

async fn handle_solve(
    State(wf): State<AppState>,
    Json(req): Json<SolveRequest>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let (tx, rx) = tokio::sync::mpsc::channel::<String>(4096);

    tokio::task::spawn_blocking(move || {
        let charset: Vec<char> = req.charset.chars().collect();
        let n = charset.len();

        let wt = WidthTable {
            charset: charset.clone(),
            width_table: req.width_table,
            left_edge: req.left_edge,
            right_edge: req.right_edge,
            n,
        };

        let constraint = if let (Some(sa), Some(sn), Some(acc)) =
            (req.state_allowed, req.state_next, req.accept_states)
        {
            let num_states = sa.len();
            let mut accept = vec![false; num_states];
            for &s in &acc {
                if s < num_states { accept[s] = true; }
            }
            Constraint { state_allowed: sa, state_next: sn, accept_states: accept }
        } else {
            let all: Vec<usize> = (0..n).collect();
            Constraint {
                state_allowed: vec![all],
                state_next: vec![vec![0i32; n]],
                accept_states: vec![true],
            }
        };

        let equiv = compute_equiv_classes(&wt, &[]);
        let deduped_allowed = dedup_state_allowed(&equiv, &constraint);

        let (auto_min, auto_max) = compute_length_bounds(&wt, req.target, req.tolerance);
        let min_length = req.min_length.unwrap_or(auto_min);
        let max_length = req.max_length.unwrap_or(auto_max);
        let result_limit = req.max_results.unwrap_or(10_000);
        let filter = req.filter;
        let filter_prefix = req.filter_prefix;
        let filter_suffix = req.filter_suffix;

        let prefix_depth = if n <= 52 { 2 } else { 1 };
        let prefix_depth = prefix_depth.min(max_length);
        let prefixes = generate_prefixes(&wt, req.target, req.tolerance, prefix_depth, &constraint, &deduped_allowed);

        let total = Arc::new(AtomicUsize::new(0));

        prefixes.par_iter().for_each(|prefix_data| {
            if total.load(Ordering::Relaxed) >= result_limit {
                return;
            }
            let (prefix, prefix_width, last_idx, pfx_state) = prefix_data;
            let mut results = solve_subtree(
                &wt, req.target, req.tolerance,
                min_length, max_length,
                prefix, *prefix_width, *last_idx,
                &constraint, *pfx_state,
                &equiv, &deduped_allowed,
                result_limit,
            );
            results.sort_by(|a, b| a.error.partial_cmp(&b.error).unwrap());

            for r in results {
                if total.load(Ordering::Relaxed) >= result_limit {
                    break;
                }
                if !wf.check_word(&r.text, &filter, &filter_prefix, &filter_suffix) {
                    continue;
                }
                total.fetch_add(1, Ordering::Relaxed);
                let entry = ResultEntry::from(r);
                let _ = tx.blocking_send(serde_json::to_string(&entry).unwrap());
            }
        });

        // Send done event
        let done = DoneEntry { done: true, total: total.load(Ordering::Relaxed) };
        let _ = tx.blocking_send(serde_json::to_string(&done).unwrap());
    });

    let stream = ReceiverStream::new(rx).map(|json_str| {
        Ok(Event::default().data(json_str))
    });

    Sse::new(stream)
}

async fn handle_full_name(
    State(wf): State<AppState>,
    Json(req): Json<FullNameRequest>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let (tx, rx) = tokio::sync::mpsc::channel::<String>(4096);

    tokio::task::spawn_blocking(move || {
        let charset: Vec<char> = req.word_charset.chars().collect();
        let result_limit = req.max_results.unwrap_or(10_000);
        let filter = req.filter;
        let filter_prefix = req.filter_prefix;
        let filter_suffix = req.filter_suffix;

        let results = full_name::solve_full_name(
            &charset,
            &req.wt1_table, &req.wt1_left_edge, &req.wt1_right_edge,
            &req.wt2_table, &req.wt2_right_edge,
            &req.space_advance, &req.left_after_space,
            req.target, req.tolerance, req.uppercase_only,
            result_limit,
        );

        let mut sent = 0;
        for r in results {
            if sent >= result_limit { break; }
            if !wf.check_full_name(&r.text, &filter, &filter_prefix, &filter_suffix) {
                continue;
            }
            sent += 1;
            let entry = ResultEntry::from(r);
            let _ = tx.blocking_send(serde_json::to_string(&entry).unwrap());
        }

        let done = DoneEntry { done: true, total: sent };
        let _ = tx.blocking_send(serde_json::to_string(&done).unwrap());
    });

    let stream = ReceiverStream::new(rx).map(|json_str| {
        Ok(Event::default().data(json_str))
    });

    Sse::new(stream)
}

// ── Prefix generation ──

fn generate_prefixes(
    wt: &WidthTable, target: f64, tolerance: f64, depth: usize, constraint: &Constraint,
    deduped_allowed: &[Vec<usize>],
) -> Vec<(String, f64, i32, usize)> {
    let mut prefixes = Vec::new();

    fn expand(
        wt: &WidthTable, target: f64, tolerance: f64, constraint: &Constraint,
        deduped_allowed: &[Vec<usize>],
        pfx: &mut Vec<u8>, acc_width: f64, last_idx: i32, remaining: usize, cstate: usize,
        prefixes: &mut Vec<(String, f64, i32, usize)>,
    ) {
        if remaining == 0 {
            let text = unsafe { String::from_utf8_unchecked(pfx.clone()) };
            prefixes.push((text, acc_width, last_idx, cstate));
            return;
        }
        for &next_idx in &deduped_allowed[cstate] {
            let advance = if last_idx == -1 {
                wt.left_edge[next_idx]
            } else {
                wt.advance(last_idx as usize, next_idx)
            };
            let new_width = acc_width + advance;
            if new_width > target + tolerance { continue; }
            let ns = constraint.state_next[cstate][next_idx];
            if ns < 0 { continue; }
            pfx.push(wt.charset[next_idx] as u8);
            expand(wt, target, tolerance, constraint, deduped_allowed, pfx, new_width, next_idx as i32, remaining - 1, ns as usize, prefixes);
            pfx.pop();
        }
    }

    expand(wt, target, tolerance, constraint, deduped_allowed, &mut Vec::new(), 0.0, -1, depth, 0, &mut prefixes);
    prefixes
}

// ── Health check ──

async fn health() -> &'static str { "ok" }

#[tokio::main]
async fn main() {
    let port = std::env::var("SOLVER_PORT").unwrap_or_else(|_| "3100".to_string());
    let addr = format!("127.0.0.1:{}", port);

    let data_dir = std::env::var("DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("unredact/data"));
    let wf = Arc::new(WordFilter::load(&data_dir));

    let app = Router::new()
        .route("/health", axum::routing::get(health))
        .route("/solve", post(handle_solve))
        .route("/solve/full-name", post(handle_full_name))
        .layer(CorsLayer::permissive())
        .with_state(wf);

    eprintln!("Solver listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
