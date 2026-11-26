// What the formula editor offers: the source fields a formula can read, the functions (with
// a plain description, an example and a sentence the block builder shows), the starter
// templates and the building blocks. The editor, the help and the smart-filter builder all
// read this one list (`store_formula_catalog`).
use serde_json::{Value as Json, json};

#[derive(Debug)]
pub struct FnSpec {
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    pub min: usize,
    pub max: usize,
    /// logic | text | number | list | date
    pub category: &'static str,
    /// What the block builder calls it.
    pub label: &'static str,
    pub summary: &'static str,
    pub example: &'static str,
    /// number | text | boolean | date | list | any | branches (the type its results share) | item
    pub result: &'static str,
    pub params: &'static [&'static str],
    /// The block sentence: `{0}` … are the argument slots, `{…}` repeats the rest.
    pub sentence: &'static str,
}

const MANY: usize = usize::MAX;

macro_rules! f {
    ($name:literal, [$($alias:literal),*], $min:expr, $max:expr, $cat:literal, $label:literal, $summary:literal, $example:literal, $result:literal, [$($p:literal),*], $sentence:literal) => {
        FnSpec { name: $name, aliases: &[$($alias),*], min: $min, max: $max, category: $cat, label: $label, summary: $summary, example: $example, result: $result, params: &[$($p),*], sentence: $sentence }
    };
}

pub static FUNCTIONS: &[FnSpec] = &[
    // Logic
    f!("if", [], 3, 3, "logic", "If … then … otherwise", "Gives one value when a condition holds and another when it does not.", "if({Year} > 2020, \"Recent\", \"Older\")", "branches", ["condition", "then", "otherwise"], "If {0} then {1} otherwise {2}"),
    f!("ifs", [], 2, 41, "logic", "First condition that holds", "Checks conditions in order and gives the value next to the first one that holds; a last lone value is the fallback.", "ifs({Citation count} > 100, \"High\", {Citation count} > 10, \"Some\", \"Few\")", "branches", ["condition", "value"], "First of {…}"),
    f!("and", [], 1, MANY, "logic", "All of", "True when every condition holds.", "and({Has PDF}, {Reading status} = \"read\")", "boolean", ["condition"], "All of {…}"),
    f!("or", [], 1, MANY, "logic", "Any of", "True when at least one condition holds.", "or(has({Tags}, \"key\"), {Starred})", "boolean", ["condition"], "Any of {…}"),
    f!("not", [], 1, 1, "logic", "Not", "Turns true into false and false into true.", "not({Has PDF})", "boolean", ["condition"], "Not {0}"),
    f!("coalesce", ["firstfilled", "ifempty"], 1, MANY, "logic", "First filled-in value", "Gives the first value that is not empty — handy for a fallback.", "coalesce({Short title}, {Title})", "branches", ["value"], "First filled-in of {…}"),
    f!("empty", ["isempty", "is_empty", "isblank"], 1, 1, "logic", "Is empty", "True when a value is empty (no text, no items).", "empty({Abstract})", "boolean", ["value"], "{0} is empty"),
    f!("filled", ["notempty", "isfilled"], 1, 1, "logic", "Is filled in", "True when a value is not empty.", "filled({DOI})", "boolean", ["value"], "{0} is filled in"),
    // Text
    f!("concat", ["combine"], 1, MANY, "text", "Combine text", "Joins values into one piece of text.", "concat(first_author(), \" \", {Year})", "text", ["part"], "Combine {…}"),
    f!("join", [], 1, 2, "text", "Join a list", "Joins the items of a list with a separator (a comma by default).", "join({Tags}, \", \")", "text", ["list", "separator"], "Join {0} with {1}"),
    f!("lower", ["lowercase"], 1, 1, "text", "Lowercase", "The text in lowercase.", "lower({Title})", "text", ["text"], "Lowercase {0}"),
    f!("upper", ["uppercase"], 1, 1, "text", "Uppercase", "The text in capitals.", "upper({Journal})", "text", ["text"], "Uppercase {0}"),
    f!("capitalize", ["proper", "title_case", "titlecase"], 1, 1, "text", "Capitalise words", "Each word starting with a capital letter.", "capitalize({Reading status})", "text", ["text"], "Capitalise {0}"),
    f!("trim", [], 1, 1, "text", "Tidy spaces", "Removes extra spaces.", "trim({Title})", "text", ["text"], "Tidy {0}"),
    f!("length", ["len"], 1, 1, "text", "Length", "How many characters a text has (or items a list has).", "length({Abstract})", "number", ["text"], "Length of {0}"),
    f!("left", [], 2, 2, "text", "First characters", "The first n characters.", "left({Title}, 40)", "text", ["text", "count"], "First {1} characters of {0}"),
    f!("right", [], 2, 2, "text", "Last characters", "The last n characters.", "right({DOI}, 4)", "text", ["text", "count"], "Last {1} characters of {0}"),
    f!("slice", ["substring", "mid", "substr"], 2, 3, "text", "Part of text", "Characters from a position (1 is the first), optionally only so many.", "slice({Title}, 1, 10)", "text", ["text", "from", "count"], "Part of {0} from {1}, {2} long"),
    f!("replace", ["substitute"], 3, 3, "text", "Replace text", "Replaces every occurrence of some text.", "replace({Title}, \"&\", \"and\")", "text", ["text", "find", "with"], "In {0} replace {1} with {2}"),
    f!("contains", ["includes"], 2, 2, "text", "Contains", "True when the text (or a list item) contains the other text, ignoring case.", "contains({Title}, \"trial\")", "boolean", ["text", "find"], "{0} contains {1}"),
    f!("starts_with", ["startswith", "begins_with"], 2, 2, "text", "Starts with", "True when the text starts with the other text, ignoring case.", "starts_with({DOI}, \"10.1038\")", "boolean", ["text", "start"], "{0} starts with {1}"),
    f!("ends_with", ["endswith"], 2, 2, "text", "Ends with", "True when the text ends with the other text, ignoring case.", "ends_with({URL}, \".pdf\")", "boolean", ["text", "end"], "{0} ends with {1}"),
    f!("split", [], 1, 2, "text", "Split into a list", "Cuts text into a list at a separator (a semicolon by default).", "split({Authors}, \";\")", "list", ["text", "separator"], "Split {0} at {1}"),
    f!("matches", ["regex", "regex_test", "regex_match", "test"], 2, 2, "text", "Matches a pattern", "True when the text matches a pattern (a regular expression; (?i) ignores case).", "matches({Title}, \"(?i)randomi[sz]ed\")", "boolean", ["text", "pattern"], "{0} matches pattern {1}"),
    f!("extract", ["regex_extract"], 2, 3, "text", "Extract with a pattern", "The part of the text a pattern finds; with ( ) the first captured part, or the numbered one.", "extract({Abstract}, \"n ?= ?(\\\\d+)\")", "text", ["text", "pattern", "group"], "From {0} extract {1}"),
    f!("replace_pattern", ["regex_replace"], 3, 3, "text", "Replace a pattern", "Replaces whatever a pattern finds; $1 puts back a captured part.", "replace_pattern({Title}, \"\\\\s+\", \" \")", "text", ["text", "pattern", "with"], "In {0} replace pattern {1} with {2}"),
    f!("extract_year", ["year_in"], 1, 1, "text", "Find a year", "The first year (1500–2099) mentioned in a text.", "extract_year({Extra})", "number", ["text"], "Year mentioned in {0}"),
    f!("first_author", ["firstauthor"], 0, 1, "text", "First author", "The family name of the first author (of this source, or of a list of names).", "first_author()", "text", ["authors"], "First author's family name"),
    f!("text", ["string", "to_text"], 1, 1, "text", "As text", "The value written as text.", "text({Year})", "text", ["value"], "{0} as text"),
    f!("number", ["value", "to_number"], 1, 1, "number", "As a number", "Reads a number, also from text such as “n = 1,200”.", "number({Sample size})", "number", ["value"], "{0} as a number"),
    f!("format_number", ["fixed"], 1, 2, "number", "Format a number", "A number as text with thousands separators and so many decimals.", "format_number({Citation count})", "text", ["number", "decimals"], "{0} formatted with {1} decimals"),
    // Numbers
    f!("round", [], 1, 2, "number", "Round", "Rounds to whole numbers, or to so many decimals.", "round({FWCI}, 1)", "number", ["number", "decimals"], "Round {0} to {1} decimals"),
    f!("floor", ["rounddown"], 1, 1, "number", "Round down", "Rounds down to a whole number.", "floor({Pages} / 10)", "number", ["number"], "Round {0} down"),
    f!("ceil", ["roundup", "ceiling"], 1, 1, "number", "Round up", "Rounds up to a whole number.", "ceil({Pages} / 30)", "number", ["number"], "Round {0} up"),
    f!("abs", [], 1, 1, "number", "Without sign", "The number without its minus sign.", "abs({Year} - 2020)", "number", ["number"], "{0} without sign"),
    f!("sqrt", [], 1, 1, "number", "Square root", "The square root.", "sqrt({Citation count})", "number", ["number"], "Square root of {0}"),
    f!("pow", ["power"], 2, 2, "number", "Power", "A number raised to a power.", "pow(2, 10)", "number", ["number", "power"], "{0} to the power {1}"),
    f!("min", [], 1, MANY, "number", "Smallest", "The smallest of the numbers (or of a list).", "min({Year}, 2000)", "number", ["number"], "Smallest of {…}"),
    f!("max", [], 1, MANY, "number", "Largest", "The largest of the numbers (or of a list).", "max({Highlights}, {Notes})", "number", ["number"], "Largest of {…}"),
    f!("sum", ["total"], 1, MANY, "number", "Add up", "The numbers (or a list's numbers) added up.", "sum({Highlights}, {Notes})", "number", ["number"], "Sum of {…}"),
    f!("average", ["avg", "mean"], 1, MANY, "number", "Average", "The average of the numbers.", "average({Rating}, {Relevance})", "number", ["number"], "Average of {…}"),
    f!("clamp", [], 3, 3, "number", "Keep between", "The number, kept between a lowest and a highest value.", "clamp({Score}, 0, 100)", "number", ["number", "lowest", "highest"], "{0} kept between {1} and {2}"),
    f!("percent", [], 2, 2, "number", "Percentage", "One number as a percentage of another (0 when the whole is 0).", "percent({Pages read}, {Pages})", "number", ["part", "whole"], "{0} as a percentage of {1}"),
    // Lists
    f!("count", [], 1, 1, "list", "Count", "How many items a list has (tags, collections, authors…).", "count({Tags})", "number", ["list"], "Number of {0}"),
    f!("has", ["has_any", "hasany"], 2, MANY, "list", "Has", "True when a list has one of the given items (tags, collections…), ignoring case.", "has({Tags}, \"to read\")", "boolean", ["list", "item"], "{0} has {…}"),
    f!("has_all", ["hasall"], 2, MANY, "list", "Has all", "True when a list has every one of the given items.", "has_all({Tags}, \"method\", \"reviewed\")", "boolean", ["list", "item"], "{0} has all of {…}"),
    f!("first", [], 1, 1, "list", "First item", "The first item of a list.", "first({Collections})", "item", ["list"], "First of {0}"),
    f!("last", [], 1, 1, "list", "Last item", "The last item of a list.", "last({Author list})", "item", ["list"], "Last of {0}"),
    f!("list", [], 1, MANY, "list", "Make a list", "A list of the given values (empty ones left out).", "list({Journal}, {Publisher})", "list", ["value"], "List of {…}"),
    // Dates
    f!("today", ["now"], 0, 0, "date", "Today", "Today's date.", "today()", "date", [], "Today"),
    f!("date", ["to_date", "datevalue"], 1, 3, "date", "Date", "A date from text (2021-03-04, March 2021…) or from year, month and day.", "date({Year}, 1, 1)", "date", ["year or text", "month", "day"], "Date from {0}"),
    f!("year", [], 1, 1, "date", "Year of", "The year of a date.", "year({Date added})", "number", ["date"], "Year of {0}"),
    f!("month", [], 1, 1, "date", "Month of", "The month (1–12) of a date.", "month({Date added})", "number", ["date"], "Month of {0}"),
    f!("day", [], 1, 1, "date", "Day of", "The day of the month of a date.", "day({Date added})", "number", ["date"], "Day of {0}"),
    f!("days_since", ["dayssince", "age_in_days"], 1, 1, "date", "Days since", "How many days ago a date was.", "days_since({Date added})", "number", ["date"], "Days since {0}"),
    f!("days_until", ["daysuntil"], 1, 1, "date", "Days until", "How many days until a date.", "days_until({Due})", "number", ["date"], "Days until {0}"),
    f!("days_between", ["datediff", "daysbetween"], 2, 2, "date", "Days between", "The days from the first date to the second.", "days_between({Date added}, {Last read})", "number", ["from", "to"], "Days from {0} to {1}"),
    f!("add_days", ["dateadd", "adddays"], 2, 2, "date", "Add days", "A date so many days later (negative for earlier).", "add_days({Date added}, 30)", "date", ["date", "days"], "{0} plus {1} days"),
    f!("format_date", ["formatdate"], 1, 2, "date", "Format a date", "A date written out: \"short\" (5 Mar 2024), \"long\", \"month\", \"year\", or a pattern like \"DD/MM/YYYY\".", "format_date({Date added}, \"short\")", "text", ["date", "style"], "{0} written as {1}"),
];

/// A function by name or alias, ignoring case.
pub fn function(name: &str) -> Option<&'static FnSpec> {
    let lower = name.to_lowercase();
    FUNCTIONS.iter().find(|f| f.name == lower || f.aliases.contains(&lower.as_str()))
}

/// Names compare without case, spaces, dashes or underscores (`{date added}` is `{Date added}`).
pub fn normalize(name: &str) -> String {
    name.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// A field every source has.
#[derive(Debug)]
pub struct FieldSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub aliases: &'static [&'static str],
    /// number | text | boolean | date | list
    pub ty: &'static str,
    /// publication | people | library | reading | files | metrics | related
    pub group: &'static str,
    pub summary: &'static str,
}

macro_rules! field {
    ($id:literal, $label:literal, [$($alias:literal),*], $ty:literal, $group:literal, $summary:literal) => {
        FieldSpec { id: $id, label: $label, aliases: &[$($alias),*], ty: $ty, group: $group, summary: $summary }
    };
}

pub static FIELDS: &[FieldSpec] = &[
    field!("title", "Title", [], "text", "publication", "The work's title."),
    field!("shortTitle", "Short title", [], "text", "publication", "A short form of the title, when there is one."),
    field!("authors", "Authors", ["creators"], "text", "people", "All authors as text, separated by semicolons."),
    field!("authorList", "Author list", [], "list", "people", "The authors as a list (for count, first and has)."),
    field!("firstAuthor", "First author", [], "text", "people", "The first author's name as written."),
    field!("authorCount", "Author count", ["number of authors"], "number", "people", "How many authors the work has."),
    field!("year", "Year", [], "number", "publication", "The year of publication."),
    field!("published", "Published", ["publication date"], "date", "publication", "The publication date, as precisely as it is known."),
    field!("journal", "Journal", ["container", "container title", "venue"], "text", "publication", "The journal, book or proceedings it appeared in."),
    field!("publisher", "Publisher", [], "text", "publication", "The publisher."),
    field!("type", "Type", ["item type"], "text", "publication", "The kind of work: journal article, book, chapter…"),
    field!("workType", "Work type", [], "text", "publication", "OpenAlex's kind of work: article, preprint, review…"),
    field!("doi", "DOI", [], "text", "publication", "The DOI."),
    field!("url", "URL", ["link"], "text", "publication", "The web address."),
    field!("abstract", "Abstract", [], "text", "publication", "The abstract."),
    field!("language", "Language", [], "text", "publication", "The language of the work."),
    field!("volume", "Volume", [], "text", "publication", "The volume."),
    field!("issue", "Issue", [], "text", "publication", "The issue."),
    field!("extra", "Extra", [], "text", "publication", "The Extra field."),
    field!("citationKey", "Citation key", ["citekey", "cite key"], "text", "library", "The key used to cite it (@key)."),
    field!("added", "Date added", ["added", "added at", "date created"], "date", "library", "When the source joined the library."),
    field!("modified", "Date modified", ["modified", "updated", "last modified"], "date", "library", "When the source last changed."),
    field!("tags", "Tags", [], "list", "library", "The source's tags."),
    field!("collections", "Collections", [], "list", "library", "The collections the source is in."),
    field!("starred", "Starred", ["favourite", "favorite"], "boolean", "library", "Whether the source is starred."),
    field!("kind", "Kind", [], "text", "library", "pdf, reference, web page, video…"),
    field!("status", "Reading status", ["read state", "readstate", "status"], "text", "reading", "unread, reading or read."),
    field!("lastOpened", "Last opened", ["opened"], "date", "reading", "When it was last opened."),
    field!("lastRead", "Last read", [], "date", "reading", "When it was last read."),
    field!("highlights", "Highlights", ["annotations", "highlight count"], "number", "reading", "How many highlights and annotations it has."),
    field!("notes", "Notes", ["note count"], "number", "reading", "How many notes are attached to it."),
    field!("pages", "Pages", ["page count", "pagecount"], "number", "files", "How many pages its file has."),
    field!("hasPdf", "Has PDF", ["pdf"], "boolean", "files", "Whether a PDF is attached."),
    field!("hasFile", "Has file", ["file present", "file"], "boolean", "files", "Whether any file is attached."),
    field!("indexed", "Indexed", [], "boolean", "files", "Whether its text has been read for search."),
    field!("citedByCount", "Citation count", ["citations", "cited by", "cited by count"], "number", "metrics", "How often it is cited, from OpenAlex."),
    field!("fwci", "FWCI", ["field weighted citation impact"], "number", "metrics", "Citations compared with similar works (1 is average)."),
    field!("oaStatus", "Open access", ["oa status", "open access status"], "text", "metrics", "gold, green, hybrid, bronze, diamond or closed."),
    field!("isOpenAccess", "Is open access", ["oa"], "boolean", "metrics", "Whether a free copy is available."),
    field!("retracted", "Retracted", [], "boolean", "metrics", "Whether the work has been retracted."),
    field!("retraction", "Retraction notice", ["correction"], "text", "metrics", "retraction, correction or expression of concern."),
    field!("citedInLibrary", "Cited in library", ["citing works in library", "cited by in library"], "number", "related", "How many works in this library cite it."),
    field!("referencesInLibrary", "References in library", ["cites in library"], "number", "related", "How many of its references are in this library."),
];

/// The core fields that always mean the source's own (a property cannot hide them).
pub const CORE: [&str; 5] = ["title", "year", "pages", "authors", "journal"];

pub fn field(name: &str) -> Option<&'static FieldSpec> {
    let key = normalize(name);
    if key.is_empty() {
        return None;
    }
    FIELDS.iter().find(|f| normalize(f.label) == key || normalize(f.id) == key || f.aliases.iter().any(|a| normalize(a) == key))
}

/// Start-from templates: `(id, name, summary, formula, display)`.
pub static TEMPLATES: &[(&str, &str, &str, &str, &str)] = &[
    ("reading-progress", "Reading progress", "How far along a source is: unread, reading or read as a percentage.", "ifs({Reading status} = \"read\", 100, {Reading status} = \"reading\", 50, 0)", "progress"),
    ("priority-score", "Priority score", "Higher for well-cited, recent, starred sources you have not read yet.", "round(min({Citation count}, 500) / 50 + max(0, 10 - (year(today()) - {Year})) + if({Starred}, 5, 0) - if({Reading status} = \"read\", 10, 0))", "plain"),
    ("days-since-added", "Days since added", "How long a source has been waiting in the library.", "days_since({Date added})", "plain"),
    ("has-pdf", "Has PDF", "A checkmark when a PDF is attached.", "{Has PDF}", "check"),
    ("short-citation", "Short citation", "First author and year, like “Curie 1903”.", "concat(coalesce(first_author(), \"Anon.\"), if({Author count} > 2, \" et al.\", if({Author count} = 2, \" & \" & first_author(last({Author list})), \"\")), \" \", coalesce(text({Year}), \"n.d.\"))", "plain"),
    ("needs-attention", "Needs attention if…", "Flags sources that are retracted, have no PDF or lack a DOI.", "ifs({Retracted}, \"Retracted\", not {Has PDF}, \"Find PDF\", empty({DOI}), \"No DOI\", \"OK\")", "badge"),
    ("age", "Age in years", "How many years ago the work was published.", "year(today()) - {Year}", "plain"),
    ("open-access-label", "Open access label", "Free to read or not, as a coloured label.", "if({Is open access}, \"Free to read\", \"Closed\")", "badge"),
    ("highlight-density", "Highlights per 10 pages", "How intensively a source has been annotated.", "if({Pages} > 0, round({Highlights} / {Pages} * 10, 1), 0)", "plain"),
    ("cited-in-library", "Cited in my library", "How many of your sources cite this one.", "{Cited in library}", "plain"),
];

/// The blocks the builder offers, grouped: each starts as the given formula.
pub static BLOCKS: &[(&str, &str, &str, &str)] = &[
    // (group, label, summary, starting formula)
    ("Combine", "Combine text", "Put fields and text together", "concat({Title}, \" \", {Year})"),
    ("Combine", "Pick from another property", "Show a property or field", "{Title}"),
    ("Combine", "First filled-in value", "Use a fallback when empty", "coalesce({Short title}, {Title})"),
    ("Decide", "If … then … else", "Choose between two values", "if({Year} > 2020, \"Recent\", \"Older\")"),
    ("Decide", "First condition that holds", "Sort into several labels", "ifs({Citation count} > 100, \"High\", {Citation count} > 10, \"Medium\", \"Low\")"),
    ("Decide", "Is empty", "Check whether something is missing", "empty({DOI})"),
    ("Count", "Count tags", "How many tags", "count({Tags})"),
    ("Count", "Has a tag", "Whether a tag is present", "has({Tags}, \"to read\")"),
    ("Count", "In a collection", "Whether it is in a collection", "has({Collections}, \"Thesis\")"),
    ("Count", "Highlights", "How many highlights", "{Highlights}"),
    ("Count", "Notes", "How many notes", "{Notes}"),
    ("Count", "Cited in library", "How many of your sources cite it", "{Cited in library}"),
    ("Dates", "Days since added", "Days since it joined the library", "days_since({Date added})"),
    ("Dates", "Days since read", "Days since you last read it", "days_since({Last read})"),
    ("Dates", "Year of a date", "The year of a date", "year({Date added})"),
    ("Dates", "Format a date", "Write a date out", "format_date({Date added}, \"short\")"),
    ("Numbers", "Number maths", "Add, subtract, multiply, divide", "{Pages} / 10"),
    ("Numbers", "Round", "Round a number", "round({FWCI}, 1)"),
    ("Numbers", "Percentage", "One number as a percentage of another", "percent({Highlights}, {Pages})"),
    ("Text", "First author", "Family name of the first author", "first_author()"),
    ("Text", "Lowercase", "Text in lowercase", "lower({Title})"),
    ("Text", "Find a year", "A year mentioned in text", "extract_year({Extra})"),
    ("Text", "Contains", "Whether text contains a word", "contains({Title}, \"trial\")"),
    ("Text", "Pattern", "Test or extract with a pattern", "extract({Abstract}, \"n ?= ?(\\\\d+)\")"),
    ("Metadata", "Journal", "The journal it appeared in", "{Journal}"),
    ("Metadata", "Citation count", "How often it is cited", "{Citation count}"),
    ("Metadata", "Open access", "Its open-access status", "{Open access}"),
    ("Metadata", "Reading status", "unread, reading or read", "{Reading status}"),
    ("Metadata", "Citation key", "The key used to cite it", "{Citation key}"),
    ("Metadata", "Has PDF", "Whether a PDF is attached", "{Has PDF}"),
    ("Metadata", "Retracted", "Whether it was retracted", "{Retracted}"),
];

/// The catalog as the editor reads it; `properties` are the workspace's `(name, type)`.
pub fn catalog(properties: &[(String, String)]) -> Json {
    let fields: Vec<Json> = FIELDS.iter().map(|f| json!({"name": f.label, "id": f.id, "type": f.ty, "group": f.group, "summary": f.summary, "aliases": f.aliases, "kind": "field"})).collect();
    let props: Vec<Json> = properties.iter().map(|(name, ty)| json!({"name": name, "type": ty, "group": "properties", "kind": if ty.starts_with("formula") { "formula" } else { "property" }})).collect();
    let functions: Vec<Json> = FUNCTIONS
        .iter()
        .map(|f| json!({"name": f.name, "aliases": f.aliases, "category": f.category, "label": f.label, "summary": f.summary, "example": f.example, "result": f.result, "params": f.params, "sentence": f.sentence, "min": f.min, "max": if f.max == MANY { Json::Null } else { json!(f.max) }}))
        .collect();
    let templates: Vec<Json> = TEMPLATES.iter().map(|(id, name, summary, formula, display)| json!({"id": id, "name": name, "summary": summary, "formula": formula, "display": display})).collect();
    let blocks: Vec<Json> = BLOCKS.iter().map(|(group, label, summary, formula)| json!({"group": group, "label": label, "summary": summary, "formula": formula})).collect();
    json!({"fields": fields, "properties": props, "functions": functions, "templates": templates, "blocks": blocks, "operators": [
        {"op": "+", "label": "plus"}, {"op": "-", "label": "minus"}, {"op": "*", "label": "times"}, {"op": "/", "label": "divided by"},
        {"op": "==", "label": "is"}, {"op": "!=", "label": "is not"}, {"op": ">", "label": "is more than"}, {"op": "<", "label": "is less than"},
        {"op": ">=", "label": "is at least"}, {"op": "<=", "label": "is at most"}, {"op": "&&", "label": "and"}, {"op": "||", "label": "or"}, {"op": "&", "label": "followed by"}
    ]})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_example_template_and_block_parses() {
        for f in FUNCTIONS {
            crate::formula::parse(f.example).unwrap_or_else(|e| panic!("{}: {e:?}", f.example));
            assert!(f.params.len() >= f.min.min(1) || f.min == 0, "{}", f.name);
        }
        for (_, _, _, formula, _) in TEMPLATES {
            crate::formula::parse(formula).unwrap_or_else(|e| panic!("{formula}: {e:?}"));
        }
        for (_, _, _, formula) in BLOCKS {
            crate::formula::parse(formula).unwrap_or_else(|e| panic!("{formula}: {e:?}"));
        }
    }

    #[test]
    fn fields_resolve_by_label_id_and_alias() {
        assert_eq!(field("date added").map(|f| f.id), Some("added"));
        assert_eq!(field("Date_Added").map(|f| f.id), Some("added"));
        assert_eq!(field("citations").map(|f| f.id), Some("citedByCount"));
        assert_eq!(field("hasPdf").map(|f| f.id), Some("hasPdf"));
        assert!(field("nonsense").is_none());
        assert_eq!(function("REGEX_EXTRACT").map(|f| f.name), Some("extract"));
    }
}
