import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import AdminSidebar from './components/AdminSidebar';

export default async function AdminLayout({ children }) {
    const session = await getServerSession(authOptions);
    
    if (!session?.user?.isAdmin) {
        redirect('/');
    }
    
    return (
        <div className="flex h-screen bg-gray-100">
            <AdminSidebar />
            <main className="flex-1 overflow-x-hidden overflow-y-auto bg-white">
                {children}
            </main>
        </div>
    );
} 