// Thin adapter for `next-auth/react` (see next-auth.js).
const session = { data: { user: { isAdmin: true, isSuperAdmin: true } }, status: 'authenticated' };
export function useSession() {
  return session;
}
