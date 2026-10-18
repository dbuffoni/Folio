//! Dynamic filesystem scope (SPEC §11.1): only paths the user handed to the app — through a native
//! dialog, a drop, "Open with"/CLI arguments, or the recent-files list of an earlier session — can
//! be read or written. There is no blanket access to the home directory.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Default)]
pub struct Scope {
    inner: Mutex<Inner>,
    persist: Option<PathBuf>,
}

#[derive(Default)]
struct Inner {
    files: HashSet<PathBuf>,
    folders: HashSet<PathBuf>,
}

fn normalize(path: &Path) -> PathBuf {
    // Resolve symlinks when the file exists; otherwise resolve the parent so new files can be granted.
    if let Ok(p) = path.canonicalize() {
        return p;
    }
    match (
        path.parent().and_then(|p| p.canonicalize().ok()),
        path.file_name(),
    ) {
        (Some(parent), Some(name)) => parent.join(name),
        _ => path.to_path_buf(),
    }
}

impl Scope {
    /// `persist` is where granted file paths are remembered so recent files can be reopened.
    pub fn new(persist: Option<PathBuf>) -> Self {
        let scope = Scope {
            inner: Mutex::default(),
            persist,
        };
        if let Some(file) = &scope.persist {
            if let Ok(text) = std::fs::read_to_string(file) {
                if let Ok(list) = serde_json::from_str::<Vec<PathBuf>>(&text) {
                    scope.inner.lock().unwrap().files.extend(list);
                }
            }
        }
        scope
    }

    pub fn grant_file(&self, path: &Path) {
        let mut inner = self.inner.lock().unwrap();
        if inner.files.insert(normalize(path)) {
            self.save(&inner);
        }
    }

    /// Folders are granted for the session only (split output, export folder).
    pub fn grant_folder(&self, path: &Path) {
        self.inner.lock().unwrap().folders.insert(normalize(path));
    }

    pub fn revoke_file(&self, path: &Path) {
        let mut inner = self.inner.lock().unwrap();
        if inner.files.remove(&normalize(path)) {
            self.save(&inner);
        }
    }

    pub fn revoke_all(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.files.clear();
        inner.folders.clear();
        self.save(&inner);
    }

    /// A granted file also covers its `.bak` backup and the temporary sibling used by atomic writes.
    pub fn allows(&self, path: &Path) -> bool {
        let inner = self.inner.lock().unwrap();
        let p = normalize(path);
        if inner.files.contains(&p) {
            return true;
        }
        if let Some(parent) = p.parent() {
            if inner.folders.contains(parent) {
                return true;
            }
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                for suffix in [".bak", ".folio-tmp"] {
                    if let Some(base) = name.strip_suffix(suffix) {
                        if inner.files.contains(&parent.join(base)) {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }

    pub fn allows_folder(&self, path: &Path) -> bool {
        self.inner
            .lock()
            .unwrap()
            .folders
            .contains(&normalize(path))
    }

    pub fn check(&self, path: &Path) -> crate::error::Result<()> {
        if self.allows(path) {
            Ok(())
        } else {
            Err(crate::error::Error::NotGranted)
        }
    }

    fn save(&self, inner: &Inner) {
        if let Some(file) = &self.persist {
            let mut list: Vec<&PathBuf> = inner.files.iter().collect();
            list.sort();
            if let Some(dir) = file.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(file, serde_json::to_string(&list).unwrap_or_default());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_granted_paths_are_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.pdf");
        let b = dir.path().join("b.pdf");
        std::fs::write(&a, b"x").unwrap();
        std::fs::write(&b, b"x").unwrap();
        let scope = Scope::new(None);
        assert!(!scope.allows(&a));
        scope.grant_file(&a);
        assert!(scope.allows(&a));
        assert!(!scope.allows(&b));
        assert!(scope.allows(&dir.path().join("a.pdf.bak")));
        assert!(scope.allows(&dir.path().join("a.pdf.folio-tmp")));
        assert!(!scope.allows(&dir.path().join("b.pdf.bak")));
        assert!(scope.check(&b).is_err());
    }

    #[test]
    fn folder_grant_covers_direct_children_only() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        let scope = Scope::new(None);
        scope.grant_folder(dir.path());
        assert!(scope.allows(&dir.path().join("new.pdf")));
        assert!(scope.allows_folder(dir.path()));
        assert!(!scope.allows(&sub.join("deep.pdf")));
        assert!(!scope.allows_folder(&sub));
    }

    #[test]
    fn traversal_and_symlinks_do_not_escape() {
        let dir = tempfile::tempdir().unwrap();
        let inside = dir.path().join("in");
        std::fs::create_dir(&inside).unwrap();
        let secret = dir.path().join("secret.txt");
        std::fs::write(&secret, b"s").unwrap();
        let scope = Scope::new(None);
        scope.grant_folder(&inside);
        assert!(!scope.allows(&inside.join("..").join("secret.txt")));
        #[cfg(unix)]
        {
            let link = inside.join("link.txt");
            std::os::unix::fs::symlink(&secret, &link).unwrap();
            assert!(!scope.allows(&link));
        }
    }

    #[test]
    fn file_grants_persist_folders_do_not() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("grants.json");
        let a = dir.path().join("a.pdf");
        std::fs::write(&a, b"x").unwrap();
        {
            let scope = Scope::new(Some(store.clone()));
            scope.grant_file(&a);
            scope.grant_folder(dir.path());
        }
        let again = Scope::new(Some(store.clone()));
        assert!(again.allows(&a));
        assert!(!again.allows(&dir.path().join("other.pdf")));
        again.revoke_file(&a);
        assert!(!Scope::new(Some(store.clone())).allows(&a));
        again.grant_file(&a);
        again.revoke_all();
        assert!(!Scope::new(Some(store)).allows(&a));
    }
}
