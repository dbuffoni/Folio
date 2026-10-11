use serde::Serialize;

/// Error returned to the frontend. `code` matches the typed errors of `@folio/core`.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Io(String),
    #[error("access to this path was not granted")]
    NotGranted,
    #[error("{0}")]
    Network(String),
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Db(String),
}

#[derive(Serialize)]
struct Payload<'a> {
    code: &'a str,
    message: String,
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        let code = match self {
            Error::Io(_) | Error::NotGranted | Error::Db(_) => "io",
            Error::Network(_) => "network",
            Error::Invalid(_) => "invalidArgument",
        };
        Payload { code, message: self.to_string() }.serialize(s)
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e.to_string())
    }
}
impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Db(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
