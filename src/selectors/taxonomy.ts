import {
  CATEGORY_TYPES,
  normalizeCategoryName,
  suggestedGroupDocument,
} from "../../functions/shared/taxonomy.js";
import {
  isCategory,
  isGroup,
  type Category,
  type CategoryGroup,
  type TaxonomyEntry,
} from "../model/types.js";

export { CATEGORY_TYPES };
export const categoryType = (entry: TaxonomyEntry) =>
  entry.category_kind ?? "custom";
export const byPosition = (left: TaxonomyEntry, right: TaxonomyEntry): number =>
  (left.sort_order ?? Number.MAX_SAFE_INTEGER) -
    (right.sort_order ?? Number.MAX_SAFE_INTEGER) ||
  left.name.localeCompare(right.name) ||
  left.id.localeCompare(right.id);
export interface TaxonomySection {
  readonly group: CategoryGroup | null;
  readonly type: ReturnType<typeof categoryType>;
  readonly categories: readonly Category[];
}
/** A single type/group/category order for settings and every picker. */
export function taxonomyTree(
  entries: readonly TaxonomyEntry[],
): readonly TaxonomySection[] {
  return CATEGORY_TYPES.flatMap(({ value }) => {
    const groups = entries
      .filter(isGroup)
      .filter((group) => categoryType(group) === value)
      .sort(byPosition);
    const categories = entries
      .filter(isCategory)
      .filter((category) => categoryType(category) === value)
      .sort(byPosition);
    const ids = new Set(groups.map((group) => group.id));
    const loose = categories.filter(
      (category) => !ids.has(category.parent_id ?? ""),
    );
    const sections: TaxonomySection[] = groups.map((group) => ({
      group,
      type: value,
      categories: categories.filter(
        (category) => category.parent_id === group.id,
      ),
    }));
    if (loose.length)
      sections.push({ group: null, type: value, categories: loose });
    return sections;
  });
}

export function importedTaxonomyPlan(
  entries: readonly TaxonomyEntry[],
  householdId: string,
  at: number,
  referenced: ReadonlySet<string>,
) {
  const groups = entries.filter(isGroup);
  const created: CategoryGroup[] = [];
  const updates: Array<{
    id: string;
    parent_id: string;
    sort_order: number;
    icon?: string;
  }> = [];
  const categories = entries.filter(isCategory);
  const imported = categories.filter(
    (category) =>
      category.id.startsWith("tax_m_") && category.archived !== true,
  );
  for (const category of imported) {
    // sort_order is also an opt-out for a category deliberately moved to no group.
    if (category.parent_id !== undefined || category.sort_order !== undefined)
      continue;
    const suggested = suggestedGroupDocument(
      householdId,
      category.name,
      category.category_kind,
      at,
    );
    const available = [...groups, ...created];
    let group =
      available.find(
        (entry) =>
          entry.id === suggested.id &&
          entry.category_kind === category.category_kind &&
          !entry.archived,
      ) ??
      available.find(
        (entry) =>
          normalizeCategoryName(entry.name) ===
            normalizeCategoryName(suggested.name) &&
          entry.category_kind === category.category_kind &&
          !entry.archived,
      );
    if (!group) {
      // A changed-type or archived standard group must never be overwritten.
      const id = entries.some((entry) => entry.id === suggested.id)
        ? `${suggested.id}_import_${categoryType(category)}`
        : suggested.id;
      group = available.find((entry) => entry.id === id);
      if (
        group &&
        (group.archived || group.category_kind !== category.category_kind)
      )
        continue;
      if (!group) {
        group = { ...suggested, id };
        created.push(group);
      }
    }
    const starter = categories.find(
      (entry) =>
        entry.id.startsWith(`cat_${householdId}.`) &&
        normalizeCategoryName(entry.name) ===
          normalizeCategoryName(category.name) &&
        entry.category_kind === category.category_kind,
    );
    updates.push({
      id: category.id,
      parent_id: group.id,
      sort_order: starter?.sort_order ?? 1000,
      ...(category.icon === undefined && starter?.icon !== undefined
        ? { icon: starter.icon }
        : {}),
    });
  }
  const archived = categories
    .filter(
      (category) =>
        category.id.startsWith(`cat_${householdId}.`) &&
        category.archived !== true &&
        category.created_at === category.updated_at &&
        !referenced.has(category.id) &&
        imported.some(
          (entry) =>
            normalizeCategoryName(entry.name) ===
              normalizeCategoryName(category.name) &&
            entry.category_kind === category.category_kind,
        ),
    )
    .map((category) => category.id);
  return { created, updates, archived };
}
