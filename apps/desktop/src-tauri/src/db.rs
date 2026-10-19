//! SQLite for application data (SPEC §9), one connection behind a mutex so SAVEPOINT-based
//! transactions issued from the frontend always run on the same connection.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::types::{Value, ValueRef};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{Map, Value as Json};
use tauri::State;

use crate::error::{Error, Result};

pub struct Db(pub Mutex<Connection>);

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")?;
        Ok(Db(Mutex::new(conn)))
    }
    #[cfg(test)]
    pub fn memory() -> Self {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        Db(Mutex::new(conn))
    }
}

fn to_sql(v: &Json) -> Result<Value> {
    Ok(match v {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Integer(*b as i64),
        Json::Number(n) => match n.as_i64() {
            Some(i) => Value::Integer(i),
            None => Value::Real(n.as_f64().unwrap_or(0.0)),
        },
        Json::String(s) => Value::Text(s.clone()),
        _ => return Err(Error::Invalid("unsupported parameter type".into())),
    })
}

fn from_sql(v: ValueRef<'_>) -> Json {
    match v {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(i) => Json::from(i),
        ValueRef::Real(f) => Json::from(f),
        ValueRef::Text(t) => Json::from(String::from_utf8_lossy(t).to_string()),
        // Repositories store binary data as base64 text; raw blobs are not part of the schema.
        ValueRef::Blob(_) => Json::Null,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    changes: usize,
    last_id: i64,
}

pub fn execute(db: &Db, sql: &str, params: &[Json]) -> Result<ExecResult> {
    let conn = db.0.lock().unwrap();
    if params.is_empty() {
        // Statements without parameters may be batches (savepoints, migrations).
        conn.execute_batch(sql)?;
        return Ok(ExecResult {
            changes: conn.changes() as usize,
            last_id: conn.last_insert_rowid(),
        });
    }
    let values = params.iter().map(to_sql).collect::<Result<Vec<_>>>()?;
    let changes = conn.execute(sql, rusqlite::params_from_iter(values))?;
    Ok(ExecResult {
        changes,
        last_id: conn.last_insert_rowid(),
    })
}

pub fn select(db: &Db, sql: &str, params: &[Json]) -> Result<Vec<Map<String, Json>>> {
    let conn = db.0.lock().unwrap();
    let values = params.iter().map(to_sql).collect::<Result<Vec<_>>>()?;
    let mut stmt = conn.prepare(sql)?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = stmt.query(rusqlite::params_from_iter(values))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut map = Map::new();
        for (i, name) in names.iter().enumerate() {
            map.insert(name.clone(), from_sql(row.get_ref(i)?));
        }
        out.push(map);
    }
    Ok(out)
}

#[tauri::command]
pub fn db_execute(sql: String, params: Vec<Json>, db: State<'_, Db>) -> Result<ExecResult> {
    execute(&db, &sql, &params)
}

#[tauri::command]
pub fn db_select(
    sql: String,
    params: Vec<Json>,
    db: State<'_, Db>,
) -> Result<Vec<Map<String, Json>>> {
    select(&db, &sql, &params)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn executes_and_selects_with_parameters() {
        let db = Db::memory();
        execute(
            &db,
            "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, n REAL, flag INTEGER)",
            &[],
        )
        .unwrap();
        let r = execute(
            &db,
            "INSERT INTO t (name, n, flag) VALUES (?, ?, ?)",
            &[json!("a"), json!(1.5), json!(true)],
        )
        .unwrap();
        assert_eq!((r.changes, r.last_id), (1, 1));
        execute(
            &db,
            "INSERT INTO t (name, n, flag) VALUES (?, ?, ?)",
            &[json!("b"), Json::Null, json!(false)],
        )
        .unwrap();
        let rows = select(
            &db,
            "SELECT * FROM t WHERE flag = ? ORDER BY id",
            &[json!(1)],
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], json!("a"));
        assert_eq!(rows[0]["n"], json!(1.5));
        assert_eq!(
            select(&db, "SELECT n FROM t WHERE name = ?", &[json!("b")]).unwrap()[0]["n"],
            Json::Null
        );
        assert!(execute(&db, "INSERT INTO t (name) VALUES (?)", &[json!([1, 2])]).is_err());
    }

    #[test]
    fn savepoints_roll_back_on_the_same_connection() {
        let db = Db::memory();
        execute(
            &db,
            "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)",
            &[],
        )
        .unwrap();
        execute(&db, "SAVEPOINT sp_0", &[]).unwrap();
        execute(&db, "INSERT INTO t (name) VALUES (?)", &[json!("x")]).unwrap();
        execute(&db, "ROLLBACK TO sp_0; RELEASE sp_0", &[]).unwrap();
        assert!(select(&db, "SELECT * FROM t", &[]).unwrap().is_empty());
    }

    #[test]
    fn foreign_keys_are_enforced() {
        let db = Db::memory();
        execute(&db, "CREATE TABLE p (id TEXT PRIMARY KEY); CREATE TABLE c (id TEXT PRIMARY KEY, p TEXT NOT NULL REFERENCES p(id) ON DELETE CASCADE)", &[]).unwrap();
        assert!(execute(
            &db,
            "INSERT INTO c (id, p) VALUES (?, ?)",
            &[json!("c1"), json!("missing")]
        )
        .is_err());
        execute(&db, "INSERT INTO p (id) VALUES (?)", &[json!("p1")]).unwrap();
        execute(
            &db,
            "INSERT INTO c (id, p) VALUES (?, ?)",
            &[json!("c1"), json!("p1")],
        )
        .unwrap();
        execute(&db, "DELETE FROM p WHERE id = ?", &[json!("p1")]).unwrap();
        assert!(select(&db, "SELECT * FROM c", &[]).unwrap().is_empty());
    }
}
