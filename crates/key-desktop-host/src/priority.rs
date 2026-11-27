// Every host command's priority, in one table (classes in key-store's priority.rs). What the
// user clicks or types is `interactive` and runs on its own executor, never behind background
// work; reads for the open view are `foreground`; polls, syncs and bulk work are `background`.
// "Slow" commands wait on the network or run long: they never count as interactive (so
// background work does not pause for a five-second web search) and the Electron bridge keeps
// them from filling its in-flight slots. The bridge reads this table (`host_priority_table`)
// and may pass a class per request in the `x-key-class` header (a user gesture, a timer).
pub use key_store::priority::Class;

/// The user's own edits and the reads behind a click or keystroke.
const INTERACTIVE: &[&str] = &[
    "store_create", "store_update", "store_edit", "store_trash", "store_delete", "store_bulk_tag", "store_tag_apply", "store_tag_apply_many",
    "store_tag_restore", "store_retag", "store_collection_create", "store_collection_update", "store_collection_reorder", "store_collection_delete",
    "store_membership", "store_note_save", "store_note_meta", "store_note_delete", "store_canvas_save", "store_canvas_delete", "store_ui_get",
    "store_ui_set", "store_undo", "store_redo", "store_add_work", "store_add_published", "store_match_identifiers", "store_source", "store_sources",
    "store_search", "store_suggest", "store_find", "store_parse_query", "store_filter_fields", "store_facets", "store_tag_index", "store_collections", "store_notes",
    "store_note", "store_canvas", "store_canvases", "store_links", "store_link_targets", "store_highlight_uses", "store_set_reading_status",
    "store_reading_event", "store_enrich", "store_media_save", "store_merge_sources", "store_merge_exact", "store_mark_distinct", "store_journal",
    "store_citation_key_set", "store_citation_key_pin", "store_biblio_copy", "store_cite_render", "store_cite_items", "store_retraction_dismiss",
    "store_rename_property_option", "store_property_options", "store_page_chunk", "store_link_related", "store_index_control", "library_annotations",
    "library_apply_annotations", "library_save_annotations", "library_import_annotations", "library_source_info", "library_source_range",
    "library_set_labels", "library_update_metadata", "library_set_property", "library_set_removed", "library_retag", "begin_pdfjs_companion_managed",
    "resolve_search_target", "native_open_buffer", "native_render", "native_text", "native_search", "native_close", "native_hibernate",
    "workspace_save_entry", "workspace_save_record", "workspace_set_project_membership", "workspace_create_project", "workspace_save_attribute",
    "workspace_rename_attribute", "workspace_delete_attribute", "workspace_apply_property_proposal", "web_add_to_library", "web_library_match", "db_add_to_library", "db_translate", "db_search_start", "db_search_cancel", "db_estimate_cancel", "db_saved_save", "db_saved_delete", "db_parse", "db_query_parse", "db_query_format", "db_strategy", "db_run",
    "web_read_identifiers", "web_filters", "feeds_mark_read", "feeds_set", "inbox_save", "inbox_state",
    // The Inbox's selection panel: its overview, Add to library (later batches are sent as
    // background and pause for the user's own work) and its undo, citations of the works.
    "inbox_selection_overview", "inbox_add", "inbox_add_undo", "inbox_works",
    "store_formula_evaluate", "store_formula_catalog", "store_formula_analyze", "store_formula_preview", "store_formula_print", "store_formula_prompt",
    "store_formula_from_answer", "store_fill_recipes", "store_fill_starters", "store_fill_recipe_save", "store_fill_recipe_delete", "store_fill_recipe_export",
    "store_fill_recipe_import", "store_fill_validate", "store_fill_estimate", "store_fill_run_create", "store_fill_run_status", "store_fill_runs", "store_fill_run",
    "store_fill_run_passages", "store_fill_review", "store_fill_run_undo", "store_fill_run_delete",
    "store_fill_cell", "store_fill_cell_use_answer", "store_fill_cell_keep", "store_fill_again_ids", "store_fill_source_cells",
    "store_selection_overview",
    // Reading mode: a highlight made in the text (store_reflow_document is a foreground read).
    "store_reflow_locate",
    "store_power_continue",
    // Systematic reviews (review_commands.rs): screening keystrokes and the reads behind them.
    "review_get", "review_stamp", "review_record", "review_queue", "review_records", "review_decide", "review_undo", "review_retract", "review_resolve", "review_reopen",
    "review_note", "review_labels", "review_flags_clear", "review_fulltext", "review_extract", "review_extraction", "review_pair_resolve", "review_create",
    "review_rename", "review_team_save", "review_protocol_save", "review_protocol_impact",
];

/// Polls behind what is on screen (the status bar, progress): after the user's own work, but
/// not starved by bulk work, or progress would look frozen.
const VISIBLE: &[&str] = &["store_status", "store_zotero_progress", "pdfjs_companion_snapshot", "store_formula_status"];

/// Nobody waits on these: timers, syncs, bulk imports and maintenance.
const BACKGROUND: &[&str] = &[
    "store_zotero_sync", "store_zotero_status", "store_zotero_plugin_status", "store_zotero_plugin_sync",
    "store_linked_sync", "store_index_priority", "store_linked_priority", "store_enrich_options", "store_duplicates_summary", "store_key_usage",
    "store_import_zotero", "store_biblio_progress", "store_md_export_status", "store_autoexport_run", "store_file_mirror_run", "store_md_export_run",
    "store_retractions_seen", "web_key_usage", "web_options", "db_options", "feeds_refresh", "feeds_counts", "feeds_environment", "feeds_retention", "feeds_purge",
    "workspace_scan_linked_folder", "pdfjs_companion_list", "host_can_suspend", "store_fill_run_next", "store_fill_run_answer", "store_fill_auto_candidates",
    "store_fill_sync",
    "store_power_state", "store_power_status",
];

/// Network or long work: never interactive, and bounded in flight by the bridge.
const SLOW_PREFIXES: &[&str] = &["db_estimate", "db_connectors_check", "store_model_download", "store_model_import", "web_search", "web_lookup", "web_find_pdf", "web_add_identifiers", "web_merge", "feeds_", "store_zotero_", "store_cite_check", "store_biblio_import", "store_biblio_export", "store_md_export_", "store_autoexport_", "store_file_mirror", "store_file_rename_apply", "store_openalex_", "store_refresh_metadata", "store_retraction_check", "store_reanalyze", "store_web_page_find", "store_web_references_detect", "scholarly_", "global_search", "semantic_library", "preprocess_", "begin_pdfjs_companion", "disposable_", "workspace_scan_linked_folder", "library_import_file", "store_import_files", "store_import_zotero", "store_tag_suggestions", "store_tag_plan", "store_duplicates", "store_find_duplicates_for", "store_merge_suggestions", "benchmark_", "web_read_page", "review_import", "review_link_library", "review_db_runs"];

/// Exceptions to the prefixes: quick despite their family.
const QUICK: &[&str] = &["feeds_mark_read", "feeds_set", "feeds_counts", "feeds_subscriptions", "feeds_from_library", "feeds_arxiv_categories", "store_zotero_progress", "store_zotero_status", "store_zotero_location", "store_zotero_plugin_status", "begin_pdfjs_companion_managed", "web_search_cancel", "db_estimate_cancel", "store_duplicates_summary", "store_md_export_status", "store_md_export_config", "store_md_export_preview", "store_md_export_restore", "store_file_mirror_config", "store_autoexport_targets"];

pub fn is_slow(command: &str) -> bool {
    !QUICK.contains(&command) && SLOW_PREFIXES.iter().any(|p| command.starts_with(p))
}

/// The command's own class.
pub fn class_of(command: &str) -> Class {
    if INTERACTIVE.contains(&command) {
        Class::Interactive
    } else if VISIBLE.contains(&command) {
        Class::Visible
    } else if BACKGROUND.contains(&command) {
        Class::Background
    } else {
        Class::Foreground
    }
}

/// The class a request runs at: the caller's hint (`x-key-class`) where given, else the
/// table's; slow work is at most foreground.
/// Edits to sources' details: after one, open views of those sources elsewhere (a reader's
/// docked details, its tab title, another window) refresh through the throttled
/// `library-changed` event (events.rs).
const SOURCE_EDITS: &[&str] = &[
    "store_update", "store_edit", "store_trash", "store_delete", "store_bulk_tag", "store_tag_apply", "store_tag_apply_many", "store_retag", "store_undo",
    "store_redo", "store_merge_sources", "store_merge_exact", "store_citation_key_set", "store_set_reading_status", "store_membership",
    "library_update_metadata", "library_set_labels", "library_set_property",
    "store_fill_cell_use_answer", "store_fill_cell_keep", "store_fill_review", "store_fill_run_undo",
];

pub fn changes_sources(command: &str) -> bool {
    SOURCE_EDITS.contains(&command)
}

pub fn resolve(command: &str, hint: Option<&str>) -> Class {
    let class = hint.and_then(Class::parse).unwrap_or_else(|| class_of(command));
    if class == Class::Interactive && is_slow(command) { Class::Foreground } else { class }
}

/// The table for the Electron bridge.
pub fn table() -> serde_json::Value {
    let mut classes = serde_json::Map::new();
    for command in INTERACTIVE {
        classes.insert((*command).into(), Class::Interactive.name().into());
    }
    for command in VISIBLE {
        classes.insert((*command).into(), Class::Visible.name().into());
    }
    for command in BACKGROUND {
        classes.insert((*command).into(), Class::Background.name().into());
    }
    serde_json::json!({
        "default": Class::Foreground.name(),
        "classes": classes,
        "slowPrefixes": SLOW_PREFIXES,
        "quick": QUICK,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clicks_are_interactive_polls_background_and_network_never_interactive() {
        assert_eq!(resolve("store_create", None), Class::Interactive);
        assert_eq!(resolve("library_apply_annotations", None), Class::Interactive);
        assert_eq!(resolve("store_status", None), Class::Visible);
        assert_eq!(resolve("store_zotero_sync", None), Class::Background);
        assert_eq!(resolve("store_analysis", None), Class::Foreground);
        // A click on a web search is still not allowed to pause the library for seconds.
        assert_eq!(resolve("web_search", Some("interactive")), Class::Foreground);
        assert_eq!(resolve("store_sources", Some("background")), Class::Background);
        assert_eq!(resolve("store_sources", Some("nonsense")), Class::Interactive);
        assert_eq!(resolve("db_estimate", Some("interactive")), Class::Foreground);
        assert!(is_slow("db_connectors_check") && !is_slow("db_estimate_cancel") && !is_slow("db_results"));
        assert!(is_slow("web_find_pdf") && !is_slow("feeds_mark_read") && !is_slow("store_source"));
        // Saving a work to the Inbox is a click; finding what to follow asks the network.
        assert_eq!(resolve("inbox_save", None), Class::Interactive);
        assert!(is_slow("feeds_suggest") && is_slow("feeds_preview") && !is_slow("inbox_state"));
        assert_eq!(resolve("inbox_add", None), Class::Interactive);
        assert_eq!(resolve("inbox_selection_overview", None), Class::Interactive);
        assert_eq!(resolve("inbox_add", Some("background")), Class::Background);
        assert_eq!(resolve("feeds_refresh", None), Class::Background);
        // A screening decision is a keystroke; an import of 20,000 records is long.
        assert_eq!(resolve("review_decide", None), Class::Interactive);
        assert!(is_slow("review_import_file") && !is_slow("review_record"));
        // Settings read the mirror's state at once; turning it on syncs.
        assert!(!is_slow("store_file_mirror_config") && is_slow("store_file_mirror") && is_slow("store_file_mirror_run"));
    }

    #[test]
    fn no_command_is_listed_twice() {
        for command in INTERACTIVE {
            assert!(!BACKGROUND.contains(command), "{command}");
            assert!(!is_slow(command) || *command == "web_add_to_library", "{command} is interactive and slow");
        }
    }
}
