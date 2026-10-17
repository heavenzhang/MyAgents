import Constants from 'expo-constants';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, findNodeHandle, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft, ChevronRight, CircleHelp, HardDrive, Info, LockKeyhole, LogOut, RefreshCw, UserRound } from 'lucide-react-native';
import { Account, NativeAttachment, isFixtureMode, requestNative } from './native';
import { dismissToExistingRoot, logoutAndConfirm, returnFromAccountRoute } from './accountPolicy';

const color = { ink: '#202522', muted: '#747B76', line: '#E7EAE7', canvas: '#F7F8F6', green: '#26734D', wash: '#E9F3ED', red: '#A7433B' };
const accountStateLabel: Record<Account['state'], string> = { 'signed-in': '已登录', 'signed-out': '未登录', authenticating: '等待浏览器授权', expired: '登录已过期' };
const knownErrors: Record<string, string> = {
  MOBILE_AUTHORIZATION_REQUIRED: '账号授权已失效，请返回会话页重新登录。',
  MOBILE_REMOTE_UNAVAILABLE: '暂时无法连接账号服务，请检查网络后重试。',
  MOBILE_CONNECTION_UNAVAILABLE: '本机连接暂不可用，请稍后重试。',
  MOBILE_ATTACHMENT_STORE_UNAVAILABLE: '暂时无法读取本机附件信息，请稍后重试。',
};

function errorText(error: unknown): string {
  const code = error instanceof Error ? error.message : 'MOBILE_ACCOUNT_UNAVAILABLE';
  return knownErrors[code] ?? '读取失败，请检查连接后重试。';
}

function useAccountStatus() {
  const generation = useRef(0);
  const [account, setAccount] = useState<Account | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const reply = await requestNative({ version: 1, kind: 'account.status' });
      if (reply.kind !== 'account') throw new Error(reply.kind === 'error' ? reply.code : 'ACCOUNT_REPLY_INVALID');
      if (generation.current === current) setAccount(reply);
    } catch (reason) {
      if (generation.current === current) setError(errorText(reason));
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }, []);
  useFocusEffect(useCallback(() => {
    void refresh();
    return () => { generation.current += 1; };
  }, [refresh]));
  return { account, busy, error, refresh };
}

function AccountFrame({ title, children, onBack }: { title: string; children: React.ReactNode; onBack?: () => void }) {
  const router = useRouter();
  const back = onBack ?? (() => returnFromAccountRoute(() => router.canGoBack(), () => router.back(), () => router.replace('/')));
  return <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
    {isFixtureMode && <View accessibilityRole="alert" style={styles.fixtureBanner}><Text style={styles.fixtureText}>演示夹具 · 合成数据</Text></View>}
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel="返回上一页" onPress={back} hitSlop={8} style={styles.back}><ArrowLeft size={22} color={color.ink}/></Pressable>
      <Text accessibilityRole="header" style={styles.headerTitle}>{title}</Text>
      <View style={styles.headerSpace}/>
    </View>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">{children}</ScrollView>
  </SafeAreaView>;
}

function AccountRow({ icon, title, detail, onPress }: { icon: React.ReactNode; title: string; detail?: string; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={detail ? `${title}，${detail}` : title} onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
    <View style={styles.rowIcon}>{icon}</View><View style={styles.rowCopy}><Text style={styles.rowTitle}>{title}</Text>{detail && <Text style={styles.rowDetail}>{detail}</Text>}</View><ChevronRight size={19} color="#A7AEA9"/>
  </Pressable>;
}

function AccountInfo({ account, busy, error, onRefresh }: { account: Account | null; busy: boolean; error: string | null; onRefresh?: () => void }) {
  return <View style={styles.accountCard}>
    <View style={styles.accountMark}><UserRound size={24} color={color.green}/></View>
    <View style={styles.accountCopy}>
      {busy ? <View style={styles.inline}><ActivityIndicator size="small" color={color.green}/><Text style={styles.muted}>正在读取账号状态…</Text></View>
        : error ? <><Text style={styles.rowTitle}>账号状态暂不可用</Text><Text style={styles.rowDetail}>{error}</Text></>
          : <><Text style={styles.accountName}>{account?.displayName || (account?.state === 'signed-in' ? '已登录账号' : '未登录')}</Text><Text style={styles.rowDetail}>{account ? accountStateLabel[account.state] : '状态未知'}</Text></>}
      {onRefresh && <Pressable accessibilityRole="button" accessibilityLabel="刷新账号状态" disabled={busy} onPress={onRefresh} style={styles.refresh}><RefreshCw size={15} color={color.green}/><Text style={styles.refreshText}>刷新状态</Text></Pressable>}
    </View>
  </View>;
}

export function AccountHomeScreen() {
  const router = useRouter();
  const status = useAccountStatus();
  return <AccountFrame title="账号与设置">
    <AccountInfo {...status}/>
    <Text style={styles.section}>账号</Text>
    <View style={styles.card}>
      <AccountRow icon={<UserRound size={19} color={color.green}/>} title="个人资料" detail="查看当前账号信息" onPress={() => router.push('/account/profile')}/>
      <AccountRow icon={<LockKeyhole size={19} color={color.green}/>} title="安全与登录" detail="刷新登录状态或退出账号" onPress={() => router.push('/account/security')}/>
    </View>
    <Text style={styles.section}>应用</Text>
    <View style={styles.card}>
      <AccountRow icon={<HardDrive size={19} color={color.green}/>} title="本机文件" detail="查看待发送文件与图片" onPress={() => router.push('/account/storage')}/>
      <AccountRow icon={<Info size={19} color={color.green}/>} title="关于 MoXBots" detail="应用版本与内部构建信息" onPress={() => router.push('/account/about')}/>
      <AccountRow icon={<CircleHelp size={19} color={color.green}/>} title="使用帮助" detail="登录、Bot、会话与附件" onPress={() => router.push('/account/help')}/>
    </View>
    <Text style={styles.footnote}>账号信息由账号服务提供。</Text>
  </AccountFrame>;
}

export function ProfileScreen() {
  const status = useAccountStatus();
  return <AccountFrame title="个人资料"><AccountInfo {...status} onRefresh={status.refresh}/>
    <Text style={styles.section}>账号信息</Text>
    <View style={styles.card}>
      <KeyValue label="显示名称" value={status.account?.displayName ?? '未提供'}/>
      <KeyValue label="账号标识" value={status.account?.principalId ?? '未提供'} selectable/>
      <KeyValue label="登录状态" value={status.account ? accountStateLabel[status.account.state] : status.busy ? '读取中' : '未知'}/>
    </View>
    <Text style={styles.footnote}>资料由账号服务提供；当前暂不支持修改。</Text>
  </AccountFrame>;
}

export function SecurityScreen() {
  const router = useRouter();
  const status = useAccountStatus();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const logoutTriggerRef = useRef<React.ElementRef<typeof Pressable>>(null);
  const cancelLogoutRef = useRef<React.ElementRef<typeof Pressable>>(null);
  const confirmLogoutRef = useRef<React.ElementRef<typeof Pressable>>(null);
  const modalWasOpenRef = useRef(false);
  const focusButton = (button: React.ElementRef<typeof Pressable> | null) => {
    if (!button) return;
    if (Platform.OS === 'web') {
      (button as React.ElementRef<typeof Pressable> & { focus?: () => void }).focus?.();
      return;
    }
    const node = findNodeHandle(button);
    if (node != null) AccessibilityInfo.setAccessibilityFocus(node);
  };
  useEffect(() => {
    if (confirmOpen) modalWasOpenRef.current = true;
    else if (modalWasOpenRef.current) {
      modalWasOpenRef.current = false;
      requestAnimationFrame(() => focusButton(logoutTriggerRef.current));
    }
  }, [confirmOpen]);
  const trapModalTab = (event: unknown) => {
    if (Platform.OS !== 'web') return;
    const keyEvent = event as { key?: string; shiftKey?: boolean; target?: unknown; preventDefault?: () => void };
    if (keyEvent.key !== 'Tab') return;
    if (keyEvent.shiftKey && keyEvent.target === cancelLogoutRef.current) {
      keyEvent.preventDefault?.();
      focusButton(confirmLogoutRef.current);
    } else if (!keyEvent.shiftKey && keyEvent.target === confirmLogoutRef.current) {
      keyEvent.preventDefault?.();
      focusButton(cancelLogoutRef.current);
    }
  };
  const logout = async () => {
    setLogoutBusy(true);
    setMessage(null);
    try {
      const result = await logoutAndConfirm(
        async () => {
          const reply = await requestNative({ version: 1, kind: 'account.logout' });
          if (reply.kind !== 'account' && reply.kind !== 'error') throw new Error('ACCOUNT_LOGOUT_REPLY_INVALID');
          return reply;
        },
        () => dismissToExistingRoot(() => router.dismissTo('/')),
      );
      if (result !== 'confirmed') {
        const latest = status.account;
        const state = latest ? accountStateLabel[latest.state] : '未确认';
        setMessage(`退出状态尚未确认（当前状态：${state}）。请刷新后检查。`);
        return;
      }
      setConfirmOpen(false);
    } catch (reason) {
      setMessage(errorText(reason));
    } finally {
      setLogoutBusy(false);
    }
  };
  return <AccountFrame title="安全与登录">
    <AccountInfo {...status} onRefresh={status.refresh}/>
    {message && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.errorNotice}>{message}</Text>}
    <Text style={styles.section}>当前会话</Text>
    <View style={styles.card}>
      <KeyValue label="登录状态" value={status.account ? accountStateLabel[status.account.state] : status.busy ? '读取中' : '未知'}/>
      {status.account?.displayName && <KeyValue label="账号" value={status.account.displayName}/>}
    </View>
    <Text style={styles.footnote}>退出后会断开此账号的连接；下次使用时需要重新登录。</Text>
    <Pressable ref={logoutTriggerRef} accessibilityRole="button" accessibilityLabel="退出当前账号" accessibilityHint={status.busy || status.error ? '请先确认当前登录状态' : undefined} accessibilityState={{ disabled: logoutBusy || status.busy || !!status.error || status.account?.state !== 'signed-in' }} disabled={logoutBusy || status.busy || !!status.error || status.account?.state !== 'signed-in'} onPress={() => { setMessage(null); setConfirmOpen(true); }} style={[styles.logoutButton, (logoutBusy || status.busy || !!status.error || status.account?.state !== 'signed-in') && styles.disabledButton]}>
      {logoutBusy ? <ActivityIndicator size="small" color={color.red}/> : <LogOut size={18} color={color.red}/>}<Text style={styles.logoutText}>退出当前账号</Text>
    </Pressable>
    <Modal transparent animationType="fade" visible={confirmOpen} onShow={() => { requestAnimationFrame(() => focusButton(cancelLogoutRef.current)); }} onRequestClose={() => setConfirmOpen(false)}>
      <View style={styles.modalBackdrop}><View accessibilityViewIsModal accessibilityRole="alert" {...({ onKeyDown: trapModalTab } as object)} style={styles.confirmCard}>
        <Text accessibilityRole="header" style={styles.confirmTitle}>退出当前账号？</Text>
        <Text style={styles.confirmCopy}>此手机将退出当前账号；远程任务会继续运行，草稿会按账号分别保留。</Text>
        <View style={styles.confirmActions}><Pressable ref={cancelLogoutRef} accessibilityRole="button" onPress={() => setConfirmOpen(false)} disabled={logoutBusy} style={styles.cancelButton}><Text style={styles.cancelText}>继续使用</Text></Pressable><Pressable ref={confirmLogoutRef} accessibilityRole="button" accessibilityLabel="确认退出账号" onPress={() => void logout()} disabled={logoutBusy} style={styles.confirmButton}>{logoutBusy ? <ActivityIndicator size="small" color="#fff"/> : <Text style={styles.confirmButtonText}>确认退出</Text>}</Pressable></View>
      </View></View>
    </Modal>
  </AccountFrame>;
}

export function StorageScreen() {
  const generation = useRef(0);
  const [items, setItems] = useState<NativeAttachment[] | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setBusy(true); setError(null);
    try {
      const reply = await requestNative({ version: 1, kind: 'attachment.list' });
      if (reply.kind !== 'attachments') throw new Error(reply.kind === 'error' ? reply.code : 'ATTACHMENT_LIST_REPLY_INVALID');
      if (generation.current === current) setItems(reply.items);
    } catch (reason) { if (generation.current === current) setError(errorText(reason)); }
    finally { if (generation.current === current) setBusy(false); }
  }, []);
  useFocusEffect(useCallback(() => { void refresh(); return () => { generation.current += 1; }; }, [refresh]));
  const bytes = (items ?? []).reduce((sum, item) => sum + item.sizeBytes, 0);
  return <AccountFrame title="本机附件">
    <Text style={styles.intro}>这里只列出本机已选择的待发送文件与图片。</Text>
    <View style={styles.statsCard}><View><Text style={styles.statLabel}>附件数量</Text><Text style={styles.statValue}>{busy ? '—' : items?.length ?? '—'}</Text></View><View style={styles.statDivider}/><View><Text style={styles.statLabel}>文件总大小</Text><Text style={styles.statValue}>{busy ? '—' : formatBytes(bytes)}</Text></View><Pressable accessibilityRole="button" accessibilityLabel="重新读取附件列表" disabled={busy} onPress={() => void refresh()} style={styles.statsRefresh}><RefreshCw size={17} color={color.green}/></Pressable></View>
    {error && <Text accessibilityRole="alert" style={styles.errorNotice}>{error}</Text>}
    {busy ? <View style={styles.loading}><ActivityIndicator color={color.green}/><Text style={styles.muted}>正在读取本机文件…</Text></View> : items?.length === 0 ? <View style={styles.emptyCard}><HardDrive size={23} color={color.muted}/><Text style={styles.rowTitle}>还没有待发送文件</Text><Text style={styles.rowDetail}>在会话输入区选择文件或图片后，可在这里查看。</Text></View> : <View style={styles.card}>{items?.map((item) => <View key={item.localId} style={styles.fileRow}><View style={styles.fileIcon}><HardDrive size={17} color={color.green}/></View><View style={styles.rowCopy}><Text numberOfLines={1} style={styles.rowTitle}>{item.name}</Text><Text numberOfLines={1} style={styles.rowDetail}>{item.mimeType} · {formatBytes(item.sizeBytes)}</Text></View></View>)}</View>}
    <Text style={styles.footnote}>上传进度和移除文件请在选中文件的会话中查看。</Text>
  </AccountFrame>;
}

export function AboutScreen() {
  const version = Constants.expoConfig?.version ?? null;
  const appName = Constants.expoConfig?.name ?? null;
  return <AccountFrame title="关于 MoXBots">
    <View style={styles.aboutMark}><Text style={styles.aboutGlyph}>M</Text><Text style={styles.aboutName}>MoXBots</Text><Text style={styles.aboutCaption}>移动端</Text></View>
    <View style={styles.card}><KeyValue label="应用版本" value={version ?? '构建信息不可用'}/><KeyValue label="构建标识" value={appName ?? '构建信息不可用'}/></View>
    <Text style={styles.footnote}>版本与名称读取自当前应用构建配置；若名称包含 Internal，表示内部测试构建。</Text>
  </AccountFrame>;
}

export function HelpScreen() {
  return <AccountFrame title="使用帮助">
    <Text style={styles.intro}>MoXBots Mobile 连接已授权的账号与可连接 Bot，并继续使用原有远程会话。</Text>
    <HelpSection title="登录与连接" body="在会话页使用浏览器登录。完成授权后，页面会读取账号可访问的 Bot。若连接暂不可用，可刷新状态或检查网络。"/>
    <HelpSection title="会话与草稿" body="选择 Bot 后可打开已有会话或创建新会话。草稿按账号、Bot 和会话分别保存在本机安全存储中；设备离线时可以继续编辑，重新连接后再发送。"/>
    <HelpSection title="附件与语音" body="从输入区的加号菜单选择文件、图片或语音输入。附件需完成上传才可随消息发送；语音识别结果会先进入可编辑草稿，不会自动发送。"/>
    <HelpSection title="待确认操作" body="如果发送结果未确认，请查询同一操作的回执。应用不会自动重新发送未知结果的消息。"/>
    <HelpSection title="账号安全" body="账号信息由账号服务提供。退出账号前会二次确认；当前暂不支持修改个人资料。"/>
  </AccountFrame>;
}

function KeyValue({ label, value, selectable = false }: { label: string; value: string; selectable?: boolean }) {
  return <View style={styles.keyValue}><Text style={styles.keyLabel}>{label}</Text><Text selectable={selectable} style={styles.keyText}>{value}</Text></View>;
}

function HelpSection({ title, body }: { title: string; body: string }) {
  return <View style={styles.helpCard}><Text style={styles.rowTitle}>{title}</Text><Text style={styles.helpBody}>{body}</Text></View>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#FFFFFF' }, header: { height: 54, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.line, flexDirection: 'row', alignItems: 'center' }, back: { width: 44, height: 44, justifyContent: 'center' }, headerTitle: { marginLeft: 3, color: color.ink, fontSize: 17, fontWeight: '700' }, headerSpace: { flex: 1 }, content: { paddingHorizontal: 18, paddingTop: 20, paddingBottom: 34 },
  accountCard: { flexDirection: 'row', alignItems: 'center', padding: 16, minHeight: 94, borderRadius: 16, backgroundColor: color.canvas, gap: 13 }, accountMark: { width: 48, height: 48, borderRadius: 24, backgroundColor: color.wash, alignItems: 'center', justifyContent: 'center' }, accountCopy: { flex: 1 }, accountName: { color: color.ink, fontSize: 16, fontWeight: '700' }, inline: { flexDirection: 'row', alignItems: 'center', gap: 9 }, muted: { color: color.muted, fontSize: 13 }, refresh: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 38, alignSelf: 'flex-start' }, refreshText: { color: color.green, fontSize: 13, fontWeight: '600' }, section: { marginTop: 24, marginBottom: 10, color: color.muted, fontSize: 12, fontWeight: '700' }, card: { overflow: 'hidden', borderWidth: 1, borderColor: color.line, borderRadius: 14, backgroundColor: '#FFFFFF' }, row: { minHeight: 68, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.line }, rowPressed: { backgroundColor: color.canvas }, rowIcon: { width: 38, height: 38, borderRadius: 11, backgroundColor: color.wash, alignItems: 'center', justifyContent: 'center', marginRight: 12 }, rowCopy: { flex: 1 }, rowTitle: { color: color.ink, fontSize: 14, fontWeight: '600' }, rowDetail: { marginTop: 4, color: color.muted, fontSize: 12, lineHeight: 17 }, footnote: { marginTop: 16, color: color.muted, fontSize: 12, lineHeight: 18 },
  keyValue: { minHeight: 58, paddingHorizontal: 15, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.line, justifyContent: 'center', gap: 5 }, keyLabel: { color: color.muted, fontSize: 12 }, keyText: { color: color.ink, fontSize: 14, lineHeight: 20 }, errorNotice: { color: color.red, backgroundColor: '#FAEFED', padding: 12, borderRadius: 10, marginTop: 14, fontSize: 13, lineHeight: 18 },
  logoutButton: { minHeight: 48, marginTop: 24, borderWidth: 1, borderColor: '#E8C9C5', borderRadius: 12, flexDirection: 'row', gap: 9, alignItems: 'center', justifyContent: 'center' }, logoutText: { color: color.red, fontSize: 14, fontWeight: '600' }, disabledButton: { opacity: 0.5 }, modalBackdrop: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: 'rgba(24,31,26,0.36)' }, confirmCard: { padding: 20, backgroundColor: '#FFFFFF', borderRadius: 18 }, confirmTitle: { color: color.ink, fontSize: 18, fontWeight: '700' }, confirmCopy: { marginTop: 12, color: color.muted, fontSize: 14, lineHeight: 21 }, confirmActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 22 }, cancelButton: { minHeight: 44, paddingHorizontal: 14, borderRadius: 10, justifyContent: 'center' }, cancelText: { color: color.ink, fontSize: 14 }, confirmButton: { minWidth: 96, minHeight: 44, paddingHorizontal: 14, borderRadius: 10, backgroundColor: color.red, justifyContent: 'center', alignItems: 'center' }, confirmButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  intro: { color: color.muted, fontSize: 14, lineHeight: 21, marginBottom: 16 }, statsCard: { minHeight: 92, paddingHorizontal: 16, borderRadius: 14, backgroundColor: color.canvas, flexDirection: 'row', alignItems: 'center', gap: 18 }, statLabel: { color: color.muted, fontSize: 12 }, statValue: { marginTop: 5, color: color.ink, fontSize: 16, fontWeight: '700' }, statDivider: { width: 1, height: 42, backgroundColor: color.line }, statsRefresh: { marginLeft: 'auto', width: 44, height: 44, justifyContent: 'center', alignItems: 'center' }, loading: { paddingVertical: 34, alignItems: 'center', gap: 10 }, emptyCard: { marginTop: 16, minHeight: 140, padding: 20, borderRadius: 14, borderWidth: 1, borderColor: color.line, alignItems: 'center', justifyContent: 'center', gap: 9 }, fileRow: { minHeight: 66, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.line, gap: 11 }, fileIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: color.wash, alignItems: 'center', justifyContent: 'center' }, fixtureBanner: { minHeight: 27, backgroundColor: '#9A541C', paddingHorizontal: 10, justifyContent: 'center', alignItems: 'center' }, fixtureText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
  aboutMark: { alignItems: 'center', paddingVertical: 30 }, aboutGlyph: { width: 64, height: 64, borderRadius: 20, overflow: 'hidden', textAlign: 'center', textAlignVertical: 'center', backgroundColor: color.wash, color: color.green, fontSize: 32, fontWeight: '800', lineHeight: 64 }, aboutName: { marginTop: 12, color: color.ink, fontSize: 20, fontWeight: '700' }, aboutCaption: { marginTop: 4, color: color.muted, fontSize: 13 }, helpCard: { padding: 15, marginBottom: 10, borderRadius: 13, borderWidth: 1, borderColor: color.line }, helpBody: { marginTop: 7, color: color.muted, fontSize: 13, lineHeight: 20 },
});
