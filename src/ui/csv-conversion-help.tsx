import { Button, Card, CardContent, CardDescription, CardHeader, Textarea } from "@mako-cloud/ui";
import { Copy } from "lucide-react";
import { useState } from "react";

const CONVERSION_PROMPT = `Convert my attached transaction CSV into a Monarch-compatible CSV for import into Rational.

Create a UTF-8 file named transactions.csv with exactly these column names, in this order:
Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags,Owner,Reviewed,Id

Conversion rules:
- Keep every transaction, including identical-looking rows. Do not deduplicate, combine, omit, or invent transactions.
- Date: use YYYY-MM-DD. Ask me if the source date format is ambiguous.
- Merchant: use the merchant/payee, or the transaction description when no separate merchant is available. This field must not be empty.
- Account: use a consistent, distinct name for each account. Ask me for missing names or how to distinguish accounts with the same name. Do not merge accounts.
- Amount: use a signed decimal in the original currency's major units, without currency symbols or thousands separators. Money leaving an account is negative; money entering it is positive. For separate debit/credit columns, use credit minus debit only after confirming their meaning. Ask if the source sign convention or units are unclear. Do not round amounts or convert currencies.
- Category: preserve the original category. Keep Buy and Sell labels exactly as custom categories when present as categories or transaction types; do not reclassify them or change their signed amounts. Leave other missing categories blank.
- Original Statement: preserve the original bank description verbatim.
- Notes, Tags, and Owner: preserve source values when available; otherwise leave blank. Preserve the tags' existing separator and tell me which separator to select in Rational's preview. Retain other useful source fields as labeled text in Notes, without silently truncating them.
- Reviewed: use only Reviewed, Needs Review, or an empty cell. Preserve an explicit source review status; leave blank if none exists.
- Id: preserve the original transaction ID exactly as text, including leading zeros and long IDs. Leave blank when no stable ID exists; do not generate one.
- Do not add columns. Quote cells containing commas, quotes, or line breaks, and escape embedded double quotes by doubling them. Leave missing optional values as empty cells, not null or N/A.
- Ask me before converting if a required value is missing or ambiguous, or if an account contains multiple currencies. Report each account's currency separately so I can select it in Rational.

If I also provide dated account balances, create a separate balances.csv with exactly Date,Balance,Account. Use YYYY-MM-DD, signed decimal balances, and the same account names as transactions.csv. Do not invent balances or derive a starting balance from transaction totals alone.

Validate that the output parses as CSV, has the same transaction count as the source, and preserves the signed totals per account after any confirmed sign/unit conversion. Report those counts and totals separately for checking. Return downloadable CSV files, with explanations outside the files, and tell me about any unresolved issues before producing the final files.`;

export function CsvConversionHelp() {
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState("");
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(CONVERSION_PROMPT);
      setMessage("Prompt copied.");
    } catch {
      setExpanded(true);
      setMessage("Select and copy the prompt below.");
    }
  };

  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">Have a CSV from another app?</h2>
        <CardDescription className="max-w-prose">
          Copy this prompt into your AI assistant and attach your CSV to convert it to Monarch
          format. Upload the converted file below, then check the accounts, amounts, and preview
          before importing.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={() => void copyPrompt()}>
            <Copy aria-hidden="true" className="size-4" />
            Copy conversion prompt
          </Button>
          <span role="status" className="text-sm text-muted-foreground">{message}</span>
        </div>
        <details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
          <summary className="cursor-pointer text-sm">View conversion prompt</summary>
          <Textarea
            aria-label="CSV conversion prompt"
            className="mt-3 min-h-64 font-mono text-xs"
            rows={14}
            readOnly
            value={CONVERSION_PROMPT}
          />
        </details>
      </CardContent>
    </Card>
  );
}
