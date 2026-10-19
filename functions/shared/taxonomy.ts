/** Group suggestions for CSVs, which contain category names but no group metadata.
 * These never infer/change a category's financial type. */
export type FinancialType = "income" | "expense" | "transfer";
export const CATEGORY_TYPES = [
  { value: "income", label: "Income" },
  { value: "expense", label: "Expenses" },
  { value: "transfer", label: "Transfers" },
  { value: "custom", label: "Custom" },
] as const;
const EXPENSE_GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["Gifts & Donations", ["Charity", "Gifts"]],
  [
    "Auto & Transport",
    [
      "Auto Payment",
      "Public Transit",
      "Gas",
      "Auto Maintenance",
      "Parking & Tolls",
      "Taxi & Ride Shares",
      "Auto Insurance",
      "Auto Misc.",
    ],
  ],
  [
    "Housing",
    [
      "Mortgage",
      "Rent",
      "Home Improvement",
      "HOA",
      "Furnishings",
      "Home Insurance",
      "Home Misc.",
    ],
  ],
  [
    "Bills & Utilities",
    [
      "Garbage",
      "Water",
      "Gas & Electric",
      "Internet & Cable",
      "Phone",
      "Television",
    ],
  ],
  ["Food & Dining", ["Groceries", "Restaurants & Bars", "Coffee Shops"]],
  [
    "Travel & Lifestyle",
    [
      "Travel & Vacation",
      "Entertainment & Recreation",
      "Personal",
      "Pets",
      "Fun Money",
      "Air Travel",
    ],
  ],
  [
    "Shopping",
    ["Shopping", "Clothing", "Furniture & Housewares", "Electronics"],
  ],
  ["Children", ["Child Care", "Child Activities", "Toys & Product"]],
  ["Education", ["Student Loans", "Education"]],
  ["Health & Wellness", ["Medical", "Dentist", "Fitness"]],
  [
    "Financial",
    [
      "Loan Repayment",
      "Financial & Legal Services",
      "Financial Fees",
      "Cash & ATM",
      "Insurance",
      "Taxes",
      "Credit Card Membership",
    ],
  ],
  ["Other", ["Uncategorized", "Check", "Miscellaneous"]],
  [
    "Business",
    [
      "Advertising & Promotion",
      "Office Supplies & Expenses",
      "Business Travel & Meals",
      "Postage & Shipping",
      "Business Utilities & Communication",
      "Employee Wages & Contract Labor",
      "Business Auto Expenses",
      "Business Insurance",
      "Office Rent",
      "Business Devices",
    ],
  ],
];
export const normalizeCategoryName = (name: string): string =>
  name.trim().toLowerCase();
const groupsByCategory = new Map(
  EXPENSE_GROUPS.flatMap(([group, names]) =>
    names.map((name) => [normalizeCategoryName(name), group] as const),
  ),
);
export function suggestedGroup(
  name: string,
  kind: FinancialType | undefined,
): string {
  if (kind === "income") return "Income";
  if (kind === "transfer") return "Transfers";
  if (kind === undefined) return "Custom";
  return groupsByCategory.get(normalizeCategoryName(name)) ?? "Other";
}
export function suggestedGroupDocument(
  householdId: string,
  name: string,
  kind: FinancialType | undefined,
  at: number,
) {
  const groupName = suggestedGroup(name, kind);
  const slug = groupName
    .toLowerCase()
    .replaceAll("&", " and ")
    .replaceAll(/[^a-z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "");
  return {
    id: `grp_${householdId}.${slug}`,
    household_id: householdId,
    kind: "group" as const,
    name: groupName,
    ...(kind === undefined ? {} : { category_kind: kind }),
    sort_order:
      kind === "income"
        ? 0
        : kind === "transfer"
          ? 14
          : kind === undefined
            ? 15
            : EXPENSE_GROUPS.findIndex(([group]) => group === groupName) + 1,
    created_at: at,
    updated_at: at,
  };
}
