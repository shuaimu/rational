## Purpose
Organize household transactions into editable category groups while preserving financial classifications and existing ledger references.

## ADDED Requirements
### Requirement: Manage type, group and category hierarchy
The app SHALL present categories within ordered groups and financial types, support search and collapse, and allow creating, renaming, reordering, archiving and moving categories between compatible groups.
#### Scenario: Move a spending category
- **WHEN** a category is moved from one expense group to another
- **THEN** its ID and all ledger assignments remain unchanged, and budgets and cash-flow group totals use its new group
#### Scenario: Incompatible move
- **WHEN** a write moves an income category to an expense group or changes its type inconsistently
- **THEN** the write is rejected

### Requirement: Repair missing imported hierarchy safely
The app SHALL assign previously ungrouped imported categories to suggested groups after replication, preserving IDs, names, types and all ledger references; repeat repairs SHALL preserve user moves. It SHALL archive only unused and untouched duplicate starter categories.
#### Scenario: Repair and repeat
- **WHEN** imported Groceries and custom Buy/Sell lack groups
- **THEN** Groceries joins Food & Dining, Buy/Sell join Custom without a type change, and repeating repair creates no duplicates
#### Scenario: Used starter category
- **WHEN** a same-name starter category has a transaction, split, budget, rule or recurrence reference
- **THEN** it remains active

### Requirement: Consistent imports and selection
New cloud imports SHALL assign groups with the same suggestions, preserve existing grouping choices, and categories SHALL be selectable under their groups throughout the app.
#### Scenario: Archived history
- **WHEN** an archived category is assigned to an existing transaction
- **THEN** its name remains visible in the editor and it remains available in history filters without being offered for new assignments
