import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { importApi } from '../api/client';
import type { ImportResult } from '../api/types';

export function Import() {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const importMutation = useMutation({
    mutationFn: (file: File) => importApi.excel(file, setUploadPercent),
    onSuccess: (data) => {
      setResult(data);
      setFile(null);
      setUploadPercent(null);
      queryClient.invalidateQueries();
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setResult(null);
      setUploadPercent(null);
    }
  };

  const handleImport = () => {
    if (file) {
      importMutation.mutate(file);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Import Data</h1>

      <div className="bg-white shadow rounded-lg p-6">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Upload Excel File (.xlsx)
            </label>
            <div className="mt-1 flex items-center space-x-4">
              <input
                type="file"
                accept=".xlsx,.xls"
                onChange={handleFileChange}
                className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"
              />
              <button
                onClick={handleImport}
                disabled={!file || importMutation.isPending}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {importMutation.isPending ? 'Importing...' : 'Import'}
              </button>
            </div>
          </div>

          {importMutation.isPending && uploadPercent !== null && <p className="text-sm text-gray-600" role="status">{uploadPercent < 100 ? `Uploading workbook · ${uploadPercent}%` : 'Upload complete · processing in cloud'}</p>}
          {importMutation.isError && (
            <div className="rounded-md bg-red-50 p-4">
              <div className="text-sm text-red-700">
                Error: {(importMutation.error as Error).message}
                {uploadPercent !== null && uploadPercent < 100 && <p className="mt-2">Select the same workbook to resume its upload.</p>}
              </div>
            </div>
          )}

          {result && (
            <div className="rounded-md bg-green-50 p-4">
              <div className="text-sm text-green-700">
                <p className="font-medium">Import successful!</p>
                <ul className="mt-2 list-disc list-inside">
                  <li>Accounts created: {result.accounts_created}</li>
                  <li>Tickers created: {result.tickers_created}</li>
                  <li>Transactions imported: {result.transactions_imported}</li>
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="bg-white shadow rounded-lg p-6">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Expected Column Format</h3>
        <div className="text-sm text-gray-600 space-y-2">
          <p>The Excel file should have the following columns (case-insensitive):</p>
          <ul className="list-disc list-inside ml-4 space-y-1">
            <li><strong>account</strong> - Account code (e.g., "JW#WB", "SL#IRA")</li>
            <li><strong>ticker / symbol</strong> - Stock ticker symbol</li>
            <li><strong>type / transaction_type</strong> - Buy, Sell, Sell short, etc.</li>
            <li><strong>quantity / qty</strong> - Number of shares</li>
            <li><strong>price</strong> - Price per share</li>
            <li><strong>cost / total</strong> - Total cost</li>
            <li><strong>fees</strong> - Transaction fees (optional)</li>
            <li><strong>date / trade_date</strong> - Transaction date</li>
            <li><strong>option_code</strong> - Option contract code (optional)</li>
            <li><strong>status</strong> - open or closed (optional, defaults to open)</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
