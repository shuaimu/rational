## Purpose

Let users connect bank feeds to established household accounts while keeping their history, identity and annotations intact.

## ADDED Requirements

### Requirement: Link an existing account after import
The system SHALL offer Plaid linking from an existing account and from Connections. Following bank authorization, the user SHALL be able to select an existing compatible household account for each returned bank account. Selecting an existing account MUST NOT create a replacement account.

#### Scenario: Imported account is linked to a bank
- **WHEN** a user selects an imported checking account as the destination for the corresponding Plaid account
- **THEN** the existing account ID and imported history remain intact and future bank updates target that same account

### Requirement: Validate explicit bank mappings
The system MUST verify household ownership, open-account state, currency, supported type and one-to-one mappings before activating a connection. It MUST reject a destination already linked to a different active bank connection. Similar names alone MUST NOT establish a mapping.

#### Scenario: Incompatible destination is selected
- **WHEN** the requested bank mapping crosses households, currencies, incompatible account types or an existing active link
- **THEN** activation fails without changing any account history

### Requirement: Preserve bank authorization boundaries and resume setup
The system SHALL require the user's bank authorization and retain pending setup so a reload does not require another bank login or create another Plaid connection. Application-visible records MUST NOT contain provider access tokens.

#### Scenario: User reloads after bank authorization
- **WHEN** bank authorization succeeded but account selection was not completed
- **THEN** reopening Connections resumes the saved selection flow without exchanging another bank connection

### Requirement: Surface synchronization completion accurately
The system SHALL distinguish bank authorization, pending historical retrieval, overlap review and completed synchronization. It MUST NOT report completion merely because an initial provider response contains no transactions.

#### Scenario: Provider is preparing history
- **WHEN** Plaid reports that initial or historical retrieval is pending
- **THEN** Rational keeps the import pending for a bounded retry and does not mark its daily synchronization complete
