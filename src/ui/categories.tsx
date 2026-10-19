import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  Input,
  NativeSelect,
} from "@mako-cloud/ui";
import {
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Plus,
  Search,
  Tags,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import type { RationalApp } from "../data/rational.js";
import type { ScopeSession } from "../data/scope.js";
import type { HouseholdWrites, Patch } from "../data/writes.js";
import {
  type Category,
  type CategoryGroup,
  type CategoryKind,
  type HouseholdCollectionId,
  isCategory,
  isGroup,
  type TaxonomyEntry,
} from "../model/types.js";
import {
  CATEGORY_TYPES,
  categoryType,
  taxonomyTree,
  type TaxonomySection,
} from "../selectors/taxonomy.js";
import { amountToText, parseAmount } from "../selectors/money.js";
import { useBehavior, useQuery } from "./hooks.js";

export { taxonomyTree } from "../selectors/taxonomy.js";
type TypeChoice = CategoryKind | "custom";
const kindOf = (value: string): CategoryKind | undefined =>
  value === "custom" ? undefined : (value as CategoryKind);
const typeLabel = (entry: TaxonomyEntry) =>
  CATEGORY_TYPES.find((type) => type.value === categoryType(entry))!.label;
interface CategoryEditor {
  category: Category | null;
  groupId: string;
  type: TypeChoice;
}
interface GroupEditor {
  group: CategoryGroup | null;
  type: TypeChoice;
}

export function CategoriesScreen({
  app,
  session,
}: {
  app: RationalApp;
  session: ScopeSession<HouseholdCollectionId>;
}) {
  const entries = useQuery(session.collection("taxonomy")?.find() ?? null);
  const state = useBehavior(app.state$);
  const currency =
    state.households.find(
      (household) => household.id === state.currentHouseholdId,
    )?.currency ?? "USD";
  const sections = taxonomyTree(entries);
  const groups = entries.filter(isGroup);
  const categories = entries.filter(isCategory);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [editor, setEditor] = useState<CategoryEditor | null>(null);
  const [groupEditor, setGroupEditor] = useState<GroupEditor | null>(null);
  const [deleting, setDeleting] = useState<Category | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const writable = app.roleIn(state.currentHouseholdId) !== "viewer";
  const query = search.trim().toLowerCase();
  const keyOf = (section: TaxonomySection) =>
    section.group?.id ?? `ungrouped-${section.type}`;
  const visible = sections
    .map((section) => ({
      ...section,
      categories: section.categories.filter(
        (category) =>
          (showArchived || !category.archived) &&
          (!query ||
            category.name.toLowerCase().includes(query) ||
            section.group?.name.toLowerCase().includes(query)),
      ),
    }))
    .filter(
      (section) =>
        !query ||
        section.categories.length > 0 ||
        section.group?.name.toLowerCase().includes(query),
    );
  const attempt = async (
    action: (writes: HouseholdWrites) => Promise<unknown>,
  ): Promise<boolean> => {
    setError(null);
    setBusy(true);
    try {
      if (!app.writes) throw new Error("No household is open.");
      await action(app.writes);
      return true;
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The change could not be saved.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  };
  const addCategory = (group?: CategoryGroup) => {
    setError(null);
    const selected =
      group ??
      groups.find(
        (entry) => entry.category_kind === "expense" && !entry.archived,
      );
    setEditor({
      category: null,
      groupId: selected?.id ?? "",
      type: selected ? categoryType(selected) : "expense",
    });
  };
  const move = (
    ordered: readonly TaxonomyEntry[],
    entry: TaxonomyEntry,
    delta: number,
  ) =>
    void attempt(async (writes) => {
      const index = ordered.findIndex((item) => item.id === entry.id);
      const target = index + delta;
      if (target < 0 || target >= ordered.length) return;
      const ids = ordered.map((item) => item.id);
      [ids[index], ids[target]] = [ids[target]!, ids[index]!];
      if (isGroup(entry)) {
        for (const [position, id] of ids.entries())
          await writes.updateGroup(id, { sort_order: position });
      } else await writes.reorderCategories(ids);
    });
  const saveCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor) return;
    const data = new FormData(event.currentTarget);
    const category = editor.category;
    const name = String(data.get("name") ?? "").trim();
    const icon = String(data.get("icon") ?? "").trim();
    const group = groups.find((entry) => entry.id === editor.groupId);
    // Group membership is organizational; it never silently changes the financial type.
    const type = category
      ? categoryType(category)
      : group
        ? categoryType(group)
        : editor.type;
    const patch: Patch<TaxonomyEntry> = {
      name,
      icon: icon || null,
      parent_id: editor.groupId || null,
    };
    if (type === "expense") {
      const bucket = String(data.get("budget_bucket") ?? "flexible") as
        | "fixed"
        | "flexible"
        | "non_monthly";
      Object.assign(patch, { budget_bucket: bucket });
      if (bucket === "non_monthly") {
        const amount = String(data.get("target_amount") ?? "").trim();
        const months = String(data.get("target_months") ?? "").trim();
        try {
          Object.assign(patch, {
            target_amount: amount ? parseAmount(amount, currency) : null,
            target_months: months ? Number(months) : null,
          });
        } catch (caught) {
          setError(
            caught instanceof Error ? caught.message : "Invalid amount.",
          );
          return;
        }
      }
    }
    if (
      await attempt(async (writes) => {
        if (category)
          await writes.updateCategory(category.id, {
            ...patch,
            ...(category.parent_id === editor.groupId
              ? { sort_order: category.sort_order ?? 1000 }
              : {}),
          });
        else {
          await writes.createCategory(name, kindOf(type), {
            ...(editor.groupId ? { groupId: editor.groupId } : {}),
            ...(icon ? { icon } : {}),
            ...(patch.budget_bucket
              ? { budgetBucket: patch.budget_bucket }
              : {}),
            ...(typeof patch.target_amount === "number"
              ? { targetAmount: patch.target_amount }
              : {}),
            ...(typeof patch.target_months === "number"
              ? { targetMonths: patch.target_months }
              : {}),
          });
        }
      })
    ) {
      setEditor(null);
      setStatus(category ? `Saved ${name}.` : `Created ${name}.`);
    }
  };
  const saveGroup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!groupEditor) return;
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    if (
      await attempt(async (writes) => {
        if (groupEditor.group)
          await writes.updateGroup(groupEditor.group.id, { name });
        else
          await writes.createGroup(
            name,
            kindOf(groupEditor.type),
            Math.max(
              -1,
              ...groups
                .filter((group) => categoryType(group) === groupEditor.type)
                .map((group) => group.sort_order ?? 0),
            ) + 1,
          );
      })
    ) {
      setGroupEditor(null);
      setStatus(`Saved ${name}.`);
    }
  };
  const deleteCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!deleting) return;
    const target = String(
      new FormData(event.currentTarget).get("reassign_to") ?? "",
    );
    if (
      await attempt(async (writes) => {
        const result = await writes.deleteCategory(deleting.id, target || null);
        setStatus(
          `Deleted ${deleting.name}: ${result.transactions} transactions ${target ? `moved to ${categories.find((category) => category.id === target)?.name}` : "left uncategorized"}, ${result.budgets} budget${result.budgets === 1 ? "" : "s"} removed.`,
        );
      })
    )
      setDeleting(null);
  };
  const editorType = editor?.category
    ? categoryType(editor.category)
    : (editor?.type ?? "expense");
  const compatibleGroups = groups.filter(
    (group) => categoryType(group) === editorType && !group.archived,
  );

  return (
    <section
      aria-labelledby="categories-title"
      data-testid="categories-screen"
      className="grid gap-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1">
          <h1 id="categories-title" className="text-2xl">
            Categories
          </h1>
          <p className="text-sm text-muted-foreground">
            Organize categories into groups for your transactions, budget, and
            cash flow.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!writable}
            onClick={() => {
              setError(null);
              setGroupEditor({ group: null, type: "expense" });
            }}
          >
            New group
          </Button>
          <Button disabled={!writable} onClick={() => addCategory()}>
            <Plus />
            New category
          </Button>
        </div>
      </div>
      {error && !editor && !groupEditor && !deleting ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {status ? (
        <p
          role="status"
          data-testid="category-status"
          className="text-sm text-muted-foreground"
        >
          {status}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-52 flex-1">
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="Search categories and groups"
            placeholder="Search categories or groups"
            className="pl-9"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          Show archived
        </label>
        <Button
          variant="ghost"
          onClick={() =>
            setCollapsed(
              collapsed.size ? new Set() : new Set(sections.map(keyOf)),
            )
          }
        >
          {collapsed.size ? "Expand all" : "Collapse all"}
        </Button>
      </div>
      {CATEGORY_TYPES.map((type) => {
        const typed = visible.filter((section) => section.type === type.value);
        if (!typed.length && (query || type.value === "custom")) return null;
        return (
          <section
            key={type.value}
            aria-label={`${type.label} groups`}
            className="grid gap-3"
            data-testid={`category-type-${type.value}`}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">{type.label}</h2>
              <Button
                variant="ghost"
                size="sm"
                disabled={!writable}
                onClick={() => {
                  setError(null);
                  setGroupEditor({ group: null, type: type.value });
                }}
              >
                <Plus className="size-4" />
                Create group
              </Button>
            </div>
            {typed.map((section) => {
              const group = section.group,
                name = group?.name ?? "Ungrouped",
                key = keyOf(section);
              const closed = !query && collapsed.has(key);
              const peers = sections
                .filter(
                  (candidate) =>
                    candidate.type === type.value && candidate.group,
                )
                .map((candidate) => candidate.group!);
              const original = sections.find(
                (candidate) => keyOf(candidate) === key,
              )!;
              return (
                <Card
                  key={key}
                  className="gap-0 overflow-hidden py-0"
                  data-testid={
                    group
                      ? `group-${group.id}`
                      : `group-ungrouped-${type.value}`
                  }
                  data-name={name}
                >
                  <div className="flex items-center gap-2 bg-muted/30 px-4 py-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="-ml-2 gap-2 px-2 font-semibold"
                      aria-label={`${closed ? "Expand" : "Collapse"} ${name}`}
                      aria-expanded={!closed}
                      onClick={() =>
                        setCollapsed((current) => {
                          const next = new Set(current);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                    >
                      {closed ? (
                        <ChevronRight className="size-4" />
                      ) : (
                        <ChevronDown className="size-4" />
                      )}
                      <h3>{name}</h3>
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {section.categories.length}{" "}
                      {section.categories.length === 1
                        ? "category"
                        : "categories"}
                    </span>
                    {group ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="ml-auto"
                            aria-label={`Actions for ${name} group`}
                            disabled={!writable || busy}
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() => {
                              setError(null);
                              setGroupEditor({ group, type: type.value });
                            }}
                          >
                            Edit group
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => addCategory(group)}>
                            Add category
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={peers[0]?.id === group.id}
                            onSelect={() => move(peers, group, -1)}
                          >
                            Move up
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={peers.at(-1)?.id === group.id}
                            onSelect={() => move(peers, group, 1)}
                          >
                            Move down
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={original.categories.length > 0}
                            onSelect={() =>
                              void attempt((writes) =>
                                writes.deleteGroup(group.id),
                              )
                            }
                          >
                            Delete empty group
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                  {closed ? null : (
                    <CardContent className="grid px-4 py-1">
                      {section.categories.length === 0 ? (
                        <p className="py-4 text-sm text-muted-foreground">
                          No {showArchived ? "" : "active "}categories in this
                          group.
                        </p>
                      ) : null}
                      {section.categories.map((category) => (
                        <div
                          key={category.id}
                          data-testid={`category-${category.id}`}
                          data-name={category.name}
                          className="flex items-center gap-3 border-b py-2 last:border-0"
                        >
                          <span
                            className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-lg"
                            aria-hidden="true"
                          >
                            {category.icon ?? "·"}
                          </span>
                          <button
                            className="min-w-0 flex-1 py-1 text-left text-sm font-medium hover:underline"
                            disabled={!writable}
                            onClick={() => {
                              setError(null);
                              setEditor({
                                category,
                                groupId: category.parent_id ?? "",
                                type: categoryType(category),
                              });
                            }}
                          >
                            <span data-testid="name">{category.name}</span>
                          </button>
                          {category.archived ? (
                            <Badge variant="secondary">Archived</Badge>
                          ) : null}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`Actions for ${category.name}`}
                                disabled={!writable || busy}
                              >
                                <MoreHorizontal />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onSelect={() => {
                                  setError(null);
                                  setEditor({
                                    category,
                                    groupId: category.parent_id ?? "",
                                    type: categoryType(category),
                                  });
                                }}
                              >
                                Edit category
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={
                                  original.categories[0]?.id === category.id
                                }
                                onSelect={() =>
                                  move(original.categories, category, -1)
                                }
                              >
                                Move up
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={
                                  original.categories.at(-1)?.id === category.id
                                }
                                onSelect={() =>
                                  move(original.categories, category, 1)
                                }
                              >
                                Move down
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onSelect={() =>
                                  void attempt((writes) =>
                                    writes.updateCategory(category.id, {
                                      archived: category.archived ? null : true,
                                    }),
                                  )
                                }
                              >
                                {category.archived ? "Restore" : "Archive"}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() => {
                                  setError(null);
                                  setDeleting(category);
                                }}
                              >
                                Delete category…
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      ))}
                      {group && writable ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="my-1 justify-self-start text-muted-foreground"
                          onClick={() => addCategory(group)}
                        >
                          <Plus className="size-4" />
                          Create category
                        </Button>
                      ) : null}
                    </CardContent>
                  )}
                </Card>
              );
            })}
          </section>
        );
      })}
      {visible.length === 0 ? (
        <EmptyState
          icon={<Tags />}
          title={
            query ? "No matching categories or groups" : "No categories yet"
          }
        />
      ) : null}
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        <DialogContent>
          {editor ? (
            <form
              key={editor.category?.id ?? "new"}
              className="grid gap-4"
              aria-label={editor.category ? "Edit category" : "New category"}
              onSubmit={(event) => void saveCategory(event)}
            >
              <DialogHeader>
                <DialogTitle>
                  {editor.category ? "Edit category" : "New category"}
                </DialogTitle>
                <DialogDescription>
                  Transactions keep their category when you change its name or
                  group.
                </DialogDescription>
              </DialogHeader>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <div className="grid grid-cols-[5rem_1fr] gap-3">
                <Field label="Icon" htmlFor="category-icon">
                  <Input
                    id="category-icon"
                    name="icon"
                    maxLength={16}
                    defaultValue={editor.category?.icon ?? ""}
                    placeholder="🛒"
                  />
                </Field>
                <Field label="Name" htmlFor="category-name">
                  <Input
                    id="category-name"
                    name="name"
                    required
                    maxLength={200}
                    defaultValue={editor.category?.name ?? ""}
                  />
                </Field>
              </div>
              {editor.category ? (
                <p className="text-sm text-muted-foreground">
                  Type: {typeLabel(editor.category)}
                </p>
              ) : (
                <Field label="Type" htmlFor="category-type">
                  <NativeSelect
                    id="category-type"
                    value={editor.type}
                    onChange={(event) => {
                      const type = event.target.value as TypeChoice;
                      setEditor({
                        ...editor,
                        type,
                        groupId:
                          groups.find(
                            (group) =>
                              categoryType(group) === type && !group.archived,
                          )?.id ?? "",
                      });
                    }}
                  >
                    {CATEGORY_TYPES.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              )}
              <Field label="Group" htmlFor="category-group">
                <NativeSelect
                  id="category-group"
                  value={editor.groupId}
                  onChange={(event) =>
                    setEditor({ ...editor, groupId: event.target.value })
                  }
                >
                  <option value="">Ungrouped</option>
                  {compatibleGroups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {editorType === "expense" ? (
                <>
                  <Field label="Budget bucket" htmlFor="category-bucket">
                    <NativeSelect
                      id="category-bucket"
                      name="budget_bucket"
                      defaultValue={
                        editor.category?.budget_bucket ?? "flexible"
                      }
                    >
                      <option value="fixed">Fixed</option>
                      <option value="flexible">Flexible</option>
                      <option value="non_monthly">Non-monthly</option>
                    </NativeSelect>
                  </Field>
                  <details>
                    <summary className="cursor-pointer text-sm text-muted-foreground">
                      Non-monthly target
                    </summary>
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <Field
                        label={`Target amount (${currency})`}
                        htmlFor="category-target"
                      >
                        <Input
                          id="category-target"
                          name="target_amount"
                          inputMode="decimal"
                          defaultValue={
                            editor.category?.target_amount === undefined
                              ? ""
                              : amountToText(
                                  editor.category.target_amount,
                                  currency,
                                )
                          }
                        />
                      </Field>
                      <Field label="Every (months)" htmlFor="category-months">
                        <Input
                          id="category-months"
                          name="target_months"
                          type="number"
                          min={1}
                          max={60}
                          defaultValue={editor.category?.target_months ?? ""}
                        />
                      </Field>
                    </div>
                  </details>
                </>
              ) : null}
              <DialogFooter>
                <Button variant="outline" onClick={() => setEditor(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy
                    ? "Saving…"
                    : editor.category
                      ? "Save category"
                      : "Add category"}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={groupEditor !== null}
        onOpenChange={(open) => {
          if (!open) setGroupEditor(null);
        }}
      >
        <DialogContent>
          {groupEditor ? (
            <form
              className="grid gap-4"
              aria-label={groupEditor.group ? "Edit group" : "New group"}
              onSubmit={(event) => void saveGroup(event)}
            >
              <DialogHeader>
                <DialogTitle>
                  {groupEditor.group ? "Edit group" : "New group"}
                </DialogTitle>
                <DialogDescription>
                  A group brings categories of the same type together in your
                  budget and reports.
                </DialogDescription>
              </DialogHeader>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <Field label="Name" htmlFor="group-name">
                <Input
                  id="group-name"
                  name="name"
                  required
                  maxLength={200}
                  defaultValue={groupEditor.group?.name ?? ""}
                />
              </Field>
              <Field label="Type" htmlFor="group-type">
                <NativeSelect
                  id="group-type"
                  disabled={groupEditor.group !== null}
                  value={groupEditor.type}
                  onChange={(event) =>
                    setGroupEditor({
                      ...groupEditor,
                      type: event.target.value as TypeChoice,
                    })
                  }
                >
                  {CATEGORY_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <DialogFooter>
                <Button variant="outline" onClick={() => setGroupEditor(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? "Saving…" : "Save group"}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent>
          {deleting ? (
            <form
              className="grid gap-4"
              onSubmit={(event) => void deleteCategory(event)}
            >
              <DialogHeader>
                <DialogTitle>Delete {deleting.name}</DialogTitle>
                <DialogDescription>
                  Choose a replacement for its transactions and splits. Its
                  category budgets will be removed and rules updated. Archive
                  instead to keep its history unchanged.
                </DialogDescription>
              </DialogHeader>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <Field label="Move its transactions to" htmlFor="reassign-to">
                <NativeSelect id="reassign-to" name="reassign_to">
                  <option value="">Leave them uncategorized</option>
                  {sections.flatMap((section) =>
                    section.categories
                      .filter(
                        (category) =>
                          category.id !== deleting.id && !category.archived,
                      )
                      .map((category) => (
                        <option key={category.id} value={category.id}>
                          {section.group ? `${section.group.name} › ` : ""}
                          {category.name}
                        </option>
                      )),
                  )}
                </NativeSelect>
              </Field>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDeleting(null)}>
                  Cancel
                </Button>
                <Button type="submit" variant="destructive" disabled={busy}>
                  Delete category
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
