//! A routine's schedule in a sentence. endue AI answers five cron fields (or a one-time routine's
//! time) and a time zone, and endue.ai words them itself; the desk words the common shapes plainly
//! ("Every weekday at 9:00") and names the expression as it is for any other.

use crate::wire_side::RoutineRow;

const DAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

/// The schedule of `row` in a sentence, with its time zone unless that is UTC; `None` when it has
/// neither a cron expression nor a time.
pub(crate) fn words(row: &RoutineRow) -> Option<String> {
    let once = row.schedule.as_deref() == Some("one_time") || row.cron_expr.is_none();
    let text = match (&row.cron_expr, &row.fire_at) {
        (_, Some(at)) if once => {
            let at = at.trim();
            match (at.get(..10), at.get(11..16)) {
                (Some(day), Some(time)) if at.len() >= 16 => format!("Once on {day} at {time}"),
                _ => format!("Once at {at}"),
            }
        }
        (Some(cron), _) => cron_words(cron),
        _ => return None,
    };
    Some(match row.timezone.as_deref().map(str::trim) {
        Some(zone) if !zone.is_empty() && zone != "UTC" => format!("{text} ({zone})"),
        _ => text,
    })
}

/// Five cron fields in a sentence.
pub(crate) fn cron_words(cron: &str) -> String {
    let fields: Vec<&str> = cron.split_whitespace().collect();
    let plain = || format!("On the schedule {}", fields.join(" "));
    let [minute, hour, day, month, weekday] = fields[..] else {
        return plain();
    };
    if month != "*" {
        return plain();
    }
    let every = |field: &str| field.strip_prefix("*/").and_then(|n| n.parse::<u32>().ok());
    if day == "*" && weekday == "*" {
        match (minute, hour, every(minute), every(hour)) {
            ("*", "*", _, _) => return "Every minute".to_owned(),
            (_, "*", Some(n), _) => return format!("Every {n} minutes"),
            (m, "*", None, _) if m.parse::<u32>().is_ok_and(|m| m < 60) => {
                return format!("Every hour at :{:0>2}", m);
            }
            ("0", _, _, Some(n)) => return format!("Every {n} hours"),
            _ => {}
        }
    }
    let Some(times) = times(minute, hour) else {
        return plain();
    };
    match (day, weekday) {
        ("*", "*") => format!("Every day at {times}"),
        ("*", days) => match weekdays(days) {
            Some(days) => format!("Every {days} at {times}"),
            None => plain(),
        },
        (d, "*") if d.parse::<u32>().is_ok_and(|d| (1..=31).contains(&d)) => {
            format!("Every month on day {d} at {times}")
        }
        _ => plain(),
    }
}

/// "9:00", or "9:00 and 18:00" for a list of hours, when the minute is one number.
fn times(minute: &str, hour: &str) -> Option<String> {
    let minute: u32 = minute.parse().ok().filter(|m| *m < 60)?;
    let hours: Vec<u32> = hour
        .split(',')
        .map(|h| h.parse().ok().filter(|h| *h < 24))
        .collect::<Option<_>>()?;
    let times: Vec<String> = hours.iter().map(|h| format!("{h}:{minute:02}")).collect();
    Some(list(&times))
}

/// "weekday", "weekend day", or the days named.
fn weekdays(field: &str) -> Option<String> {
    let mut days = [false; 7];
    for part in field.split(',') {
        let (from, to) = part.split_once('-').unwrap_or((part, part));
        let (from, to): (usize, usize) = (from.parse().ok()?, to.parse().ok()?);
        if from > to || to > 7 {
            return None;
        }
        for day in from..=to {
            days[day % 7] = true;
        }
    }
    let on: Vec<usize> = (0..7).filter(|d| days[*d]).collect();
    Some(match on[..] {
        [1, 2, 3, 4, 5] => "weekday".to_owned(),
        [0, 6] => "weekend day".to_owned(),
        [0, 1, 2, 3, 4, 5, 6] => "day".to_owned(),
        _ => list(&on.iter().map(|d| DAYS[*d].to_owned()).collect::<Vec<_>>()),
    })
}

fn list(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

#[cfg(test)]
mod tests {
    use super::cron_words;

    #[test]
    fn common_schedules_read_as_sentences() {
        for (cron, words) in [
            ("0 9 * * 1-5", "Every weekday at 9:00"),
            ("30 8 * * *", "Every day at 8:30"),
            ("0 9,18 * * *", "Every day at 9:00 and 18:00"),
            ("0 10 * * 1,4", "Every Monday and Thursday at 10:00"),
            ("0 10 * * 0,6", "Every weekend day at 10:00"),
            ("0 7 1 * *", "Every month on day 1 at 7:00"),
            ("*/15 * * * *", "Every 15 minutes"),
            ("5 * * * *", "Every hour at :05"),
            ("0 */6 * * *", "Every 6 hours"),
            ("* * * * *", "Every minute"),
            ("0 9 1-7 * 1", "On the schedule 0 9 1-7 * 1"),
            ("0 9 * 1 *", "On the schedule 0 9 * 1 *"),
            ("nonsense", "On the schedule nonsense"),
        ] {
            assert_eq!(cron_words(cron), words, "{cron}");
        }
    }
}
