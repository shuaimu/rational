## Why
Monarch history imports created ungrouped categories alongside unused starter duplicates. The existing hierarchy is hard to manage and therefore missing from everyday reports.

## What Changes
- Present income, expense, transfer and preserved custom types, each containing groups and categories.
- Add searchable, collapsible groups and category editing/moving with compatible-type validation.
- Repair imported category group assignments without rewriting ledger records or classifications; archive only untouched, unreferenced starter duplicates.
- Give future cloud imports consistent group assignments and retain existing user choices.

## Capabilities
### New Capabilities
- `category-hierarchy`: Manage and consistently read a safe category hierarchy.
### Modified Capabilities
None.

## Impact
Household taxonomy writes, settings, category pickers, import function and regression tests. Existing schema fields suffice; Investment and transaction arithmetic remain unchanged.
