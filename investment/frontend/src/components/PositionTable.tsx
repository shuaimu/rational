import type { Position } from '../api/types';
import { formatDateOnly } from '../utils/date';

interface PositionTableProps {
  positions: Position[];
}

export function PositionTable({ positions }: PositionTableProps) {
  const formatCurrency = (value: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);

  const formatDate = (date: string | null) =>
    formatDateOnly(date, { month: 'short', day: 'numeric', year: '2-digit' });

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Account
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Ticker
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
              Quantity
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
              Avg Cost
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
              Total Cost
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Option
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Expiration
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {positions.map((pos, idx) => (
            <tr key={`${pos.account_id}-${pos.ticker_id}-${pos.option_code || idx}`} className="hover:bg-gray-50">
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                {pos.account_code}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                {pos.ticker_symbol}
              </td>
              <td className={`px-6 py-4 whitespace-nowrap text-sm text-right ${pos.quantity < 0 ? 'text-red-600' : 'text-gray-900'}`}>
                {pos.quantity}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                {formatCurrency(pos.avg_cost)}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                {formatCurrency(pos.total_cost)}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {pos.option_code ? (
                  <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                    pos.option_type === 'C' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                  }`}>
                    {pos.option_type === 'C' ? 'Call' : 'Put'} {pos.strike_price}
                  </span>
                ) : '-'}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {formatDate(pos.expiration_date)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
