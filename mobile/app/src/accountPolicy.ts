import type { Account } from './native';

type LogoutReply = Account | { kind: 'error'; code: string };

/** Continue the UI logout path only after the native owner confirms signed-out. */
export async function logoutAndConfirm(
  requestLogout: () => Promise<LogoutReply>,
  onConfirmed: () => void,
): Promise<'confirmed' | 'not-confirmed'> {
  const reply = await requestLogout();
  if (reply.kind === 'error') throw new Error(reply.code);
  if (reply.kind !== 'account') throw new Error('ACCOUNT_LOGOUT_REPLY_INVALID');
  if (reply.state !== 'signed-out') return 'not-confirmed';
  onConfirmed();
  return 'confirmed';
}

export function returnFromAccountRoute(canGoBack: () => boolean, goBack: () => void, goHome: () => void): void {
  if (canGoBack()) goBack();
  else goHome();
}

/** Pop an account route back to the already-mounted chat owner after confirmed logout. */
export function dismissToExistingRoot(dismissToRoot: () => void): void {
  dismissToRoot();
}
