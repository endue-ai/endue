//! The work of one turn as the thread shows it: its phase, its times, how many tool calls were
//! attempted, succeeded and failed, and one group per tool (its label, its connector, its calls and
//! failures). Folded from a run's `step` and `run_presentation` events, or from a page's tool rows.

use serde::{Deserialize, Serialize};

use crate::wire_chat::RunPresentation;

/// Groups a turn's work holds at most.
pub const MAX_GROUPS: usize = 50;
const MAX_LABEL: usize = 120;

/// One tool's calls in a turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatWorkGroup {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    pub calls: u32,
    pub failed: u32,
}

/// The work of a turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatWork {
    /// `running`, `completed`, `awaiting_input`, `partial`, `failed` or `cancelled`.
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    pub attempted: u32,
    pub succeeded: u32,
    pub failed: u32,
    /// At most `MAX_GROUPS`.
    pub groups: Vec<ChatWorkGroup>,
}

/// A turn's work while it is folded.
#[derive(Debug, Clone, Default)]
pub(crate) struct Tally {
    groups: Vec<ChatWorkGroup>,
    presented: Option<RunPresentation>,
}

impl Tally {
    /// One call of the tool `name`.
    pub(crate) fn call(&mut self, name: &str, failed: bool) {
        let (label, provider) = label_of(name);
        if label.is_empty() {
            return;
        }
        let group = match self
            .groups
            .iter_mut()
            .position(|g| g.label == label && g.provider == provider)
        {
            Some(at) => &mut self.groups[at],
            None if self.groups.len() < MAX_GROUPS => {
                self.groups.push(ChatWorkGroup {
                    label,
                    provider,
                    calls: 0,
                    failed: 0,
                });
                let last = self.groups.len() - 1;
                &mut self.groups[last]
            }
            None => return,
        };
        group.calls = group.calls.saturating_add(1);
        if failed {
            group.failed = group.failed.saturating_add(1);
        }
    }

    /// The run's summary, when it is no older than the one held.
    pub(crate) fn present(&mut self, presentation: &RunPresentation) {
        if self
            .presented
            .as_ref()
            .is_none_or(|held| held.revision <= presentation.revision)
        {
            self.presented = Some(presentation.clone());
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.groups.is_empty() && self.presented.is_none()
    }

    /// The work as it stands; `phase` unless the run's summary names one.
    pub(crate) fn work(&self, phase: &str) -> ChatWork {
        let mut groups = self.groups.clone();
        let presented = self.presented.as_ref();
        if groups.is_empty()
            && let Some(presentation) = presented
        {
            for reference in presentation
                .references
                .iter()
                .filter(|r| r.kind == "connector")
            {
                if groups.len() == MAX_GROUPS || reference.label.trim().is_empty() {
                    continue;
                }
                let failed = u32::from(reference.usage.as_deref() == Some("failed"));
                groups.push(ChatWorkGroup {
                    label: clip(reference.label.trim()),
                    provider: reference.provider.clone().filter(|p| !p.is_empty()),
                    calls: 1,
                    failed,
                });
            }
        }
        let calls: u32 = groups.iter().map(|g| g.calls).sum();
        let failures: u32 = groups.iter().map(|g| g.failed).sum();
        let (attempted, succeeded, failed) = match presented.map(|p| &p.counts) {
            Some(c) if c.attempted > 0 => (c.attempted, c.succeeded, c.failed),
            _ => (calls, calls - failures, failures),
        };
        ChatWork {
            phase: presented
                .and_then(|p| p.phase.clone())
                .unwrap_or_else(|| phase.to_owned()),
            started_at: presented.and_then(|p| p.started_at.clone()),
            ended_at: presented.and_then(|p| p.ended_at.clone()),
            attempted,
            succeeded,
            failed,
            groups,
        }
    }
}

/// A tool's label and its connector: `gmail__search_2` is `gmail__search` of `gmail` (a second
/// copy of a connector on one agent ends its tools' names with `_2`).
fn label_of(name: &str) -> (String, Option<String>) {
    let name = name.trim();
    let base = match name.rsplit_once('_') {
        Some((head, n)) if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) => head,
        _ => name,
    };
    let provider = base
        .split_once("__")
        .map(|(p, _)| p)
        .filter(|p| !p.is_empty())
        .map(str::to_owned);
    (clip(base), provider)
}

fn clip(text: &str) -> String {
    text.chars().take(MAX_LABEL).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calls_fold_by_tool_and_connector() {
        let mut tally = Tally::default();
        tally.call("gmail__search", false);
        tally.call("gmail__search_2", true);
        tally.call("web_search", false);
        let work = tally.work("completed");
        assert_eq!(work.phase, "completed");
        assert_eq!((work.attempted, work.succeeded, work.failed), (3, 2, 1));
        assert_eq!(work.groups.len(), 2);
        assert_eq!(work.groups[0].label, "gmail__search");
        assert_eq!(work.groups[0].provider.as_deref(), Some("gmail"));
        assert_eq!((work.groups[0].calls, work.groups[0].failed), (2, 1));
        assert_eq!(work.groups[1].provider, None);
    }

    #[test]
    fn groups_stop_at_fifty() {
        let mut tally = Tally::default();
        for n in 0..60 {
            tally.call(&format!("tool{n}"), false);
        }
        assert_eq!(tally.work("running").groups.len(), MAX_GROUPS);
    }
}
