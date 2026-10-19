## Context
Observed Monarch settings use Income / Expenses / Transfers, then reorderable named groups, then editable categories. Rational already stores this shape but imports omit parent_id and the settings screen cannot move categories. CSV carries category names but no group names. Existing Buy/Sell custom classifications must remain unchanged.

## Goals / Non-Goals
Make the hierarchy useful for imported history and manageable across settings, pickers, budgets and reports. Preserve IDs, names, types, transaction/split assignments and totals. Do not copy private Monarch settings into product defaults or recategorize financial history.

## Decisions
Use existing taxonomy documents and optional category_kind; a separate Custom section preserves legacy custom types. Shared import group suggestions map recognized category names to standard groups; unmatched expenses use Other, income uses Income, transfers use Transfers, custom uses Custom. Suggestions are editable and do not claim to recover groups absent from CSV.

An idempotent local repair runs after initial household replication for editors/owners. It repairs only untouched imported grouping (missing parent and sort_order), uses deterministic household group IDs, and preserves later moves. Archive duplicate starter categories only when unmodified and unreferenced by transactions, splits, budgets, rules or recurrences; archive is reversible. Future imports use the same group suggestions. No transaction rewrite or local server is needed.

Settings show type headings, group counts, collapse/search, context actions and category/group dialogs. Category moves are limited to the same financial type, so regrouping cannot silently change financial totals. Selected archived categories remain visible in editors; history filters include archived categories.

## Risks / Trade-offs
CSV lacks group metadata, so inferred groups are starting points, not exact Monarch settings. Repeated imports and concurrent tabs need deterministic IDs and idempotent checks. Starter duplicates used by any rule or ledger reference stay intact. Unknown custom categories stay in Custom.

## Migration Plan
Ship repair and settings together. Existing cloud-authoritative taxonomy receives ordinary RxDB metadata writes after replication. Deploy the import function change for subsequent imports. Verify current imported hierarchy in Chrome and financial conservation in tests.

## Open Questions
None; user explicitly requested revision and implementation.
