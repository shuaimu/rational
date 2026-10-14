import { CloudJobs } from './CloudJobs';
import { Link, useLocation } from 'react-router-dom';

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const location = useLocation();
  const shellWidthClass = 'mx-auto max-w-[1600px] px-4 sm:px-6 lg:px-8';

  const navItems = [
    { path: '/', label: 'Dashboard' },
    { path: '/performance', label: 'Performance' },
    { path: '/transactions', label: 'Transactions' },
    { path: '/positions', label: 'Positions' },
    { path: '/import', label: 'Import' },
    { path: '/brokers', label: 'Brokers' },
    { path: '/admin', label: 'Admin' },
  ];

  return (
    <div className="min-h-screen bg-gray-100">
      <nav className="bg-white shadow-sm">
        <div className={shellWidthClass}>
          <div className="flex justify-between h-16">
            <div className="flex">
              <div className="flex-shrink-0 flex items-center">
                <a href={import.meta.env.PROD ? "/rational/" : "/"} className="mr-4 text-sm text-indigo-600">← Rational</a><span className="text-xl font-bold text-indigo-600">Rational Investment</span>
              </div>
              <div className="hidden sm:ml-6 sm:flex sm:space-x-8">
                {navItems.map((item) => (
                  <Link
                    key={item.path}
                    to={item.path}
                    className={`${
                      location.pathname === item.path
                        ? 'border-indigo-500 text-gray-900'
                        : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
                    } inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium`}
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </div>
      </nav>
      <main className={`${shellWidthClass} py-6`}><CloudJobs />{children}</main>
    </div>
  );
}
