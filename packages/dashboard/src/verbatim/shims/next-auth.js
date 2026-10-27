// Thin adapter for `next-auth` on the server side. The engine already gated
// this page behind its own session (single-use login link), so the one user
// of a local radar is its super admin.
export async function getServerSession() {
  return { user: { isAdmin: true, isSuperAdmin: true } };
}
