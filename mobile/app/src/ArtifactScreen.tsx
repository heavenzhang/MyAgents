import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft, ChevronDown, Download, Eye, FileText, Image as ImageIcon, Pause, Play, RefreshCw, Share2, Trash2 } from 'lucide-react-native';
import { artifactListBelongsToOwner, ArtifactDownloadTracker, type ArtifactOwner } from './artifactPolicy';
import { ArtifactActionReply, ArtifactDescriptor, ArtifactDownload, isFixtureMode, QaArtifactScenario, qaArtifactScenarioOptions, requestNative, selectQaArtifactScenario, subscribeArtifactDownloadChanges, Target } from './native';

const color = { ink: '#202522', muted: '#747B76', line: '#E7EAE7', canvas: '#F7F8F6', green: '#26734D', wash: '#E9F3ED', red: '#A7433B' };
const pageLimit = 20;
const errorCopy: Record<string, string> = {
  MOBILE_REMOTE_UNAVAILABLE: '暂时无法连接成果服务，请检查网络后刷新。',
  MOBILE_ARTIFACT_NOT_FOUND: '本机没有这项成果的下载记录。',
  MOBILE_ARTIFACT_NOT_READY: '文件尚未下载完成，请完成下载后再打开或分享。',
  MOBILE_ARTIFACT_ACTIVE: '下载仍在进行，请先暂停后再移除。',
  MOBILE_ARTIFACT_BUSY: '另一项成果正在下载，请稍后继续。',
  MOBILE_ARTIFACT_FOREGROUND_REQUIRED: '请保持应用在前台后重试。',
  MOBILE_ARTIFACT_REFRESH_REQUIRED: '成果列表已更新，请刷新后重新选择。',
  MOBILE_ARTIFACT_CACHE_LIMIT: '本机可用空间或下载数量已达到上限，请先移除不需要的副本。',
  MOBILE_ARTIFACT_HASH_MISMATCH: '文件校验未通过，请重新检查下载状态。',
  MOBILE_TARGET_INVALID: '当前 Bot 已不可用，请返回会话重新选择。',
  MOBILE_ACCOUNT_CHANGED: '账号状态已变化，请返回后重新打开成果。',
};

function asParam(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function scopeMatchesDownload(value: ArtifactDownload, owner: ArtifactOwner): boolean {
  return artifactListBelongsToOwner(value, owner);
}

export default function ArtifactScreen() {
  const params = useLocalSearchParams<{ targetId?: string | string[]; sessionId?: string | string[] }>();
  const routeTargetId = asParam(params.targetId);
  const routeSessionId = asParam(params.sessionId);
  const router = useRouter();
  const [target, setTarget] = useState<Target | null>(null);
  const ownerRef = useRef<ArtifactOwner | null>(null);
  const trackerRef = useRef(new ArtifactDownloadTracker());
  const trackerEpochRef = useRef(0);
  const routeEpochRef = useRef(0);
  const routeActiveRef = useRef(false);
  const listFlightRef = useRef<number | null>(null);
  const listFlightSequenceRef = useRef(0);
  const itemsRef = useRef<ArtifactDescriptor[]>([]);
  const [items, setItems] = useState<ArtifactDescriptor[]>([]);
  const [downloads, setDownloads] = useState<Record<string, ArtifactDownload>>({});
  const [unknown, setUnknown] = useState<Record<string, boolean>>({});
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});
  const busyIdsRef = useRef(new Set<string>());
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState<{ text: string; code?: string } | null>(null);
  const [noSession, setNoSession] = useState(false);
  const [qaMenuOpen, setQaMenuOpen] = useState(false);
  const [qaScenario, setQaScenario] = useState<QaArtifactScenario>('normal');

  const routeIsCurrent = useCallback((epoch: number) => routeActiveRef.current && routeEpochRef.current === epoch && AppState.currentState === 'active', []);
  const claimRow = useCallback((artifactId: string): boolean => {
    if (busyIdsRef.current.has(artifactId)) return false;
    busyIdsRef.current.add(artifactId);
    setBusyIds((prior) => ({ ...prior, [artifactId]: true }));
    return true;
  }, []);
  const releaseRow = useCallback((artifactId: string) => {
    busyIdsRef.current.delete(artifactId);
    setBusyIds((prior) => ({ ...prior, [artifactId]: false }));
  }, []);

  const loadPage = useCallback(async (epoch: number, currentOwner: ArtifactOwner, before: string | null, reset: boolean) => {
    if (!routeIsCurrent(epoch) || listFlightRef.current !== null) return;
    const flight = ++listFlightSequenceRef.current;
    listFlightRef.current = flight;
    if (reset) setLoading(true); else setLoadingMore(true);
    setNotice(null);
    try {
      if (!routeIsCurrent(epoch) || ownerRef.current === null || !artifactListBelongsToOwner(ownerRef.current, currentOwner)) return;
      const response = await requestNative({ version: 1, kind: 'artifact.list', targetId: currentOwner.targetId, sessionId: currentOwner.sessionId, limit: pageLimit, ...(before ? { before } : {}) });
      if (!routeIsCurrent(epoch) || ownerRef.current === null || !artifactListBelongsToOwner(ownerRef.current, currentOwner)) return;
      if (response.kind === 'error') throw new Error(response.code);
      if (response.kind !== 'artifact-list' || !artifactListBelongsToOwner(response, currentOwner)) throw new Error('MOBILE_ARTIFACT_RESPONSE_INVALID');
      const combined = reset ? response.items : [...itemsRef.current, ...response.items];
      const unique = [...new Map(combined.map((item) => [item.artifactId, item])).values()];
      itemsRef.current = unique;
      setItems(unique);
      setHasMore(response.hasMore);
      setNextBefore(response.nextBefore);
      setUnknown({});
    } catch (reason) {
      if (routeIsCurrent(epoch)) setNotice(noticeFor(reason));
    } finally {
      if (listFlightRef.current === flight) listFlightRef.current = null;
      if (routeIsCurrent(epoch)) { setLoading(false); setLoadingMore(false); }
    }
  }, [routeIsCurrent]);

  const loadContext = useCallback(async (epoch: number) => {
    if (!routeIsCurrent(epoch)) return;
    listFlightRef.current = null;
    setLoading(true); setLoadingMore(false); setNotice(null); setTarget(null); setNoSession(false);
    ownerRef.current = null; itemsRef.current = []; setItems([]); setDownloads({}); setUnknown({});
    if (!routeTargetId) { setNotice({ text: '没有指定会话成果。请从会话页的成果入口打开。' }); setLoading(false); return; }
    try {
      const accountReply = await requestNative({ version: 1, kind: 'account.status' });
      if (!routeIsCurrent(epoch)) return;
      if (accountReply.kind !== 'account' || accountReply.state !== 'signed-in') throw new Error(accountReply.kind === 'error' ? accountReply.code : 'MOBILE_AUTHORIZATION_REQUIRED');
      const targetsReply = await requestNative({ version: 1, kind: 'targets.list' });
      if (!routeIsCurrent(epoch)) return;
      if (targetsReply.kind !== 'targets') throw new Error(targetsReply.kind === 'error' ? targetsReply.code : 'MOBILE_TARGETS_REPLY_INVALID');
      const selected = targetsReply.items.find((item) => item.targetId === routeTargetId);
      if (!selected) throw new Error('MOBILE_TARGET_INVALID');
      setTarget(selected);
      if (!routeSessionId) { setNoSession(true); setLoading(false); return; }
      if (!selected.online) { setNotice({ text: '此 Bot 当前离线，连接后再查看或下载成果。' }); setLoading(false); return; }
      const nextOwner: ArtifactOwner = { targetId: selected.targetId, identityKey: selected.identityKey, agentId: selected.agentId, sessionId: routeSessionId };
      ownerRef.current = nextOwner;
      trackerEpochRef.current = trackerRef.current.activate(nextOwner);
      await loadPage(epoch, nextOwner, null, true);
    } catch (reason) {
      if (routeIsCurrent(epoch)) { setNotice(noticeFor(reason)); setLoading(false); }
    }
  }, [loadPage, routeIsCurrent, routeSessionId, routeTargetId]);

  useFocusEffect(useCallback(() => {
    routeActiveRef.current = true;
    const epoch = ++routeEpochRef.current;
    void loadContext(epoch);
    const eventSubscription = subscribeArtifactDownloadChanges((event) => {
      if (!routeIsCurrent(routeEpochRef.current) || !trackerRef.current.acceptEvent(event, trackerEpochRef.current)) return;
      const currentOwner = ownerRef.current;
      if (!currentOwner || !scopeMatchesDownload(event, currentOwner)) return;
      const descriptor = itemsRef.current.find((item) => item.artifactId === event.artifactId);
      if (!descriptor || descriptor.name !== event.name || descriptor.mimeType !== event.mimeType || descriptor.sha256 !== event.sha256) return;
      setDownloads((prior) => ({ ...prior, [event.artifactId]: event }));
      setUnknown((prior) => ({ ...prior, [event.artifactId]: false }));
    });
    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && routeActiveRef.current) {
        const resumedEpoch = ++routeEpochRef.current;
        trackerRef.current.blur();
        ownerRef.current = null;
        void loadContext(resumedEpoch);
      } else if (nextState !== 'active') {
        ++routeEpochRef.current;
        trackerRef.current.blur();
        ownerRef.current = null;
      }
    });
    return () => {
      routeActiveRef.current = false;
      ++routeEpochRef.current;
      trackerRef.current.blur();
      trackerEpochRef.current = 0;
      ownerRef.current = null;
      eventSubscription();
      appStateSubscription.remove();
    };
  }, [loadContext, routeIsCurrent]));

  const queryStatus = useCallback(async (descriptor: ArtifactDescriptor, epoch = routeEpochRef.current): Promise<ArtifactDownload | null> => {
    const currentOwner = ownerRef.current;
    if (!currentOwner || !routeIsCurrent(epoch)) return null;
    const flight = trackerRef.current.begin(descriptor.artifactId, trackerEpochRef.current);
    const response = await requestNative({ version: 1, kind: 'artifact.status', targetId: currentOwner.targetId, sessionId: currentOwner.sessionId, artifactId: descriptor.artifactId });
    if (!routeIsCurrent(epoch) || ownerRef.current === null || !artifactListBelongsToOwner(ownerRef.current, currentOwner)) return null;
    if (response.kind === 'error') {
      if (response.code === 'MOBILE_ARTIFACT_NOT_FOUND') {
        if (trackerRef.current.acceptAbsence(flight)) {
          setDownloads((prior) => { const next = { ...prior }; delete next[descriptor.artifactId]; return next; });
          setUnknown((prior) => ({ ...prior, [descriptor.artifactId]: false }));
        }
        return trackerRef.current.latest(descriptor.artifactId, trackerEpochRef.current);
      }
      throw new Error(response.code);
    }
    if (response.kind !== 'artifact-download' || !scopeMatchesDownload(response, currentOwner)
      || response.artifactId !== descriptor.artifactId || response.name !== descriptor.name || response.mimeType !== descriptor.mimeType || response.sha256 !== descriptor.sha256) {
      throw new Error('MOBILE_ARTIFACT_RESPONSE_INVALID');
    }
    if (trackerRef.current.acceptReply(response, flight)) {
      setDownloads((prior) => ({ ...prior, [descriptor.artifactId]: response }));
      setUnknown((prior) => ({ ...prior, [descriptor.artifactId]: false }));
    }
    return trackerRef.current.latest(descriptor.artifactId, trackerEpochRef.current);
  }, [routeIsCurrent]);

  const beginDownload = useCallback(async (descriptor: ArtifactDescriptor, epoch: number) => {
    const currentOwner = ownerRef.current;
    if (!currentOwner || !routeIsCurrent(epoch) || unknown[descriptor.artifactId] || !claimRow(descriptor.artifactId)) return;
    let downloadDispatched = false;
    try {
      const checked = await queryStatus(descriptor, epoch);
      if (!routeIsCurrent(epoch) || !ownerRef.current || !artifactListBelongsToOwner(ownerRef.current, currentOwner)) return;
      const latest = trackerRef.current.latest(descriptor.artifactId, trackerEpochRef.current) ?? checked;
      if (latest?.state === 'ready' || latest?.state === 'downloading') return;
      const flight = trackerRef.current.begin(descriptor.artifactId, trackerEpochRef.current);
      downloadDispatched = true;
      const response = await requestNative({ version: 1, kind: 'artifact.download', targetId: currentOwner.targetId, sessionId: currentOwner.sessionId, artifact: descriptor });
      if (!routeIsCurrent(epoch) || !ownerRef.current || !artifactListBelongsToOwner(ownerRef.current, currentOwner)) return;
      if (response.kind === 'error') throw new Error(response.code);
      if (response.kind !== 'artifact-download' || !scopeMatchesDownload(response, currentOwner)
        || response.artifactId !== descriptor.artifactId || response.name !== descriptor.name || response.mimeType !== descriptor.mimeType || response.sha256 !== descriptor.sha256) {
        throw new Error('MOBILE_ARTIFACT_RESPONSE_INVALID');
      }
      if (trackerRef.current.acceptReply(response, flight)) setDownloads((prior) => ({ ...prior, [descriptor.artifactId]: response }));
      setUnknown((prior) => ({ ...prior, [descriptor.artifactId]: false }));
      setNotice(null);
    } catch (reason) {
      if (!routeIsCurrent(epoch)) return;
      if (downloadDispatched) {
        setUnknown((prior) => ({ ...prior, [descriptor.artifactId]: true }));
        setNotice({ ...noticeFor(reason), text: '下载结果尚未确认。请查询本机状态后再决定下一步；应用不会自动重启下载。' });
      } else setNotice(noticeFor(reason));
    } finally {
      if (routeIsCurrent(epoch)) releaseRow(descriptor.artifactId);
    }
  }, [claimRow, queryStatus, releaseRow, routeIsCurrent, unknown]);

  const runRowAction = useCallback(async (descriptor: ArtifactDescriptor, kind: 'pause' | 'preview' | 'share' | 'remove') => {
    const currentOwner = ownerRef.current;
    const epoch = routeEpochRef.current;
    if (!currentOwner || !routeIsCurrent(epoch) || !claimRow(descriptor.artifactId)) return;
    setNotice(null);
    const pauseFlight = kind === 'pause' ? trackerRef.current.begin(descriptor.artifactId, trackerEpochRef.current) : null;
    let nativeRejected = false;
    try {
      const response = await requestNative({ version: 1, kind: `artifact.${kind}`, targetId: currentOwner.targetId, sessionId: currentOwner.sessionId, artifactId: descriptor.artifactId });
      if (!routeIsCurrent(epoch) || !ownerRef.current || !artifactListBelongsToOwner(ownerRef.current, currentOwner)) return;
      if (response.kind === 'error') { nativeRejected = true; throw new Error(response.code); }
      if (kind === 'pause') {
        if (response.kind !== 'artifact-download' || !scopeMatchesDownload(response, currentOwner) || response.artifactId !== descriptor.artifactId) throw new Error('MOBILE_ARTIFACT_RESPONSE_INVALID');
        if (pauseFlight && trackerRef.current.acceptReply(response, pauseFlight)) setDownloads((prior) => ({ ...prior, [descriptor.artifactId]: response }));
        setUnknown((prior) => ({ ...prior, [descriptor.artifactId]: false }));
      } else {
        if (response.kind !== 'artifact-action' || !actionMatches(response, currentOwner, descriptor, kind)) throw new Error('MOBILE_ARTIFACT_ACTION_INVALID');
        if (kind === 'remove') {
          setDownloads((prior) => { const next = { ...prior }; delete next[descriptor.artifactId]; return next; });
          setUnknown((prior) => ({ ...prior, [descriptor.artifactId]: false }));
          setRemoveConfirmId(null);
          setNotice({ text: '已移除本机副本；远端成果仍保留。' });
        } else setNotice({ text: kind === 'preview' ? '已在系统预览中打开。' : '已交给系统分享。' });
      }
    } catch (reason) {
      if (routeIsCurrent(epoch)) {
        if (nativeRejected) setNotice(noticeFor(reason));
        else {
          setUnknown((prior) => ({ ...prior, [descriptor.artifactId]: true }));
          setNotice({ ...noticeFor(reason), text: '操作结果尚未确认。请查询本机状态后再继续；应用不会自动重试。' });
        }
      }
    } finally {
      if (routeIsCurrent(epoch)) releaseRow(descriptor.artifactId);
    }
  }, [claimRow, releaseRow, routeIsCurrent]);

  const refreshStatus = useCallback(async (descriptor: ArtifactDescriptor) => {
    const epoch = routeEpochRef.current;
    if (!routeIsCurrent(epoch) || !claimRow(descriptor.artifactId)) return;
    setNotice(null);
    try {
      const reply = await queryStatus(descriptor, epoch);
      if (routeIsCurrent(epoch)) setNotice({ text: reply ? `本机状态：${downloadStateLabel[reply.state]}。` : '本机没有这项成果的下载记录。' });
    } catch (reason) { if (routeIsCurrent(epoch)) setNotice(noticeFor(reason)); }
    finally { if (routeIsCurrent(epoch)) releaseRow(descriptor.artifactId); }
  }, [claimRow, queryStatus, releaseRow, routeIsCurrent]);

  const refreshList = useCallback(() => {
    const epoch = routeEpochRef.current;
    const currentOwner = ownerRef.current;
    if (currentOwner && routeIsCurrent(epoch)) void loadPage(epoch, currentOwner, null, true);
    else void loadContext(epoch);
  }, [loadContext, loadPage, routeIsCurrent]);

  const loadMore = useCallback(() => {
    const epoch = routeEpochRef.current;
    const currentOwner = ownerRef.current;
    if (currentOwner && nextBefore && hasMore && routeIsCurrent(epoch)) void loadPage(epoch, currentOwner, nextBefore, false);
  }, [hasMore, loadPage, nextBefore, routeIsCurrent]);

  const chooseQa = useCallback(async (next: QaArtifactScenario) => {
    if (!isFixtureMode) return;
    await selectQaArtifactScenario(next);
    setDownloads({}); setUnknown({}); setNotice(null);
    if (ownerRef.current) trackerEpochRef.current = trackerRef.current.activate(ownerRef.current);
    setQaScenario(next); setQaMenuOpen(false);
    refreshList();
  }, [refreshList]);

  return <SafeAreaView edges={['top', 'bottom']} style={styles.safe}>
    {isFixtureMode && <View style={styles.qaBanner}><Text style={styles.qaBannerText}>演示夹具 · 以下成果及操作均为合成数据</Text><Pressable accessibilityRole="button" accessibilityLabel="切换成果演示场景" accessibilityState={{ expanded: qaMenuOpen }} onPress={() => setQaMenuOpen((value) => !value)} style={styles.qaToggle}><Text style={styles.qaToggleText}>{qaArtifactScenarioOptions.find((item) => item.id === qaScenario)?.label ?? '演示场景'} <ChevronDown size={12} color="#fff"/></Text></Pressable>{qaMenuOpen && <View style={styles.qaChoices}>{qaArtifactScenarioOptions.map((item) => <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ selected: qaScenario === item.id }} onPress={() => void chooseQa(item.id)} style={styles.qaChoice}><Text style={styles.qaChoiceText}>{item.label}</Text></Pressable>)}</View>}</View>}
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel="返回会话" onPress={() => router.canGoBack() ? router.back() : router.replace('/')} style={styles.headerButton}><ArrowLeft size={21} color={color.ink}/></Pressable>
      <View style={styles.headerCopy}><Text accessibilityRole="header" style={styles.headerTitle}>会话成果</Text><Text numberOfLines={1} style={styles.headerSubtitle}>{target?.name ?? '正在读取 Bot'}</Text></View>
      <Pressable accessibilityRole="button" accessibilityLabel="刷新成果列表" accessibilityState={{ disabled: loading }} disabled={loading} onPress={refreshList} style={styles.headerButton}><RefreshCw size={18} color={loading ? color.muted : color.green}/></Pressable>
    </View>
    <View style={styles.summary}><FileText size={18} color={color.green}/><Text style={styles.summaryText}>{routeSessionId ? `${items.length}${hasMore ? '+' : ''} 项成果` : '当前会话尚未创建'}</Text><Text style={styles.summaryHint}>{target?.deviceName ?? ''}</Text></View>
    {notice && <InlineNotice notice={notice}/>}
    {noSession ? <View style={styles.stateCard}><Text style={styles.stateTitle}>先打开已有会话</Text><Text style={styles.stateDetail}>新会话创建后，才能读取该会话的成果。</Text></View>
      : loading && items.length === 0 ? <View style={styles.loading}><ActivityIndicator color={color.green}/><Text style={styles.stateDetail}>正在读取会话成果…</Text></View>
        : items.length === 0 ? <View style={styles.stateCard}><FileText size={25} color={color.muted}/><Text style={styles.stateTitle}>{target?.online ? '暂无成果' : 'Bot 当前离线'}</Text><Text style={styles.stateDetail}>{target?.online ? '此会话还没有可下载的文件。' : '连接后可重新读取会话成果。'}</Text></View>
          : <ScrollView contentContainerStyle={styles.list}>
            {items.map((descriptor) => <ArtifactRow key={descriptor.artifactId} descriptor={descriptor} download={downloads[descriptor.artifactId] ?? null} busy={!!busyIds[descriptor.artifactId]} unknown={!!unknown[descriptor.artifactId]} removeConfirm={removeConfirmId === descriptor.artifactId} onDownload={() => void beginDownload(descriptor, routeEpochRef.current)} onStatus={() => void refreshStatus(descriptor)} onPause={() => void runRowAction(descriptor, 'pause')} onPreview={() => void runRowAction(descriptor, 'preview')} onShare={() => void runRowAction(descriptor, 'share')} onRemove={() => setRemoveConfirmId(descriptor.artifactId)} onRemoveCancel={() => setRemoveConfirmId(null)} onRemoveConfirm={() => void runRowAction(descriptor, 'remove')}/>) }
            {hasMore && <Pressable accessibilityRole="button" accessibilityLabel="加载更多成果" disabled={loadingMore} onPress={loadMore} style={styles.moreButton}>{loadingMore ? <ActivityIndicator size="small" color={color.green}/> : <Text style={styles.moreText}>加载更多</Text>}</Pressable>}
          </ScrollView>}
    <Text style={styles.footer}>下载文件只保存在本机；移除本机副本不会删除远端成果。</Text>
  </SafeAreaView>;
}

const downloadStateLabel: Record<ArtifactDownload['state'], string> = { downloading: '正在下载', ready: '已下载', paused: '已暂停' };

function actionMatches(value: ArtifactActionReply, owner: ArtifactOwner, descriptor: ArtifactDescriptor, action: 'remove' | 'preview' | 'share'): boolean {
  return value.action === action && value.targetId === owner.targetId && value.identityKey === owner.identityKey
    && value.agentId === owner.agentId && value.sessionId === owner.sessionId && value.artifactId === descriptor.artifactId
    && value.errorCode === null && value.state === (action === 'remove' ? 'removed' : 'presented');
}

function noticeFor(reason: unknown): { text: string; code: string } {
  const code = reason instanceof Error && /^[A-Z][A-Z0-9_]{2,127}$/.test(reason.message) ? reason.message : 'MOBILE_ARTIFACT_UNAVAILABLE';
  return { text: errorCopy[code] ?? '暂时无法处理这项成果，请刷新状态后重试。', code };
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function ArtifactRow({ descriptor, download, busy, unknown, removeConfirm, onDownload, onStatus, onPause, onPreview, onShare, onRemove, onRemoveCancel, onRemoveConfirm }: {
  descriptor: ArtifactDescriptor; download: ArtifactDownload | null; busy: boolean; unknown: boolean; removeConfirm: boolean;
  onDownload: () => void; onStatus: () => void; onPause: () => void; onPreview: () => void; onShare: () => void;
  onRemove: () => void; onRemoveCancel: () => void; onRemoveConfirm: () => void;
}) {
  const state = unknown ? '状态待确认' : download ? downloadStateLabel[download.state] : '尚未下载';
  const progress = download ? Math.min(100, Math.round(download.receivedBytes / Math.max(1, download.totalBytes) * 100)) : 0;
  return <View style={styles.artifactCard}>
    <View style={styles.artifactMain}><View style={styles.fileIcon}>{descriptor.mimeType.startsWith('image/') ? <ImageIcon size={18} color={color.green}/> : <FileText size={18} color={color.green}/>}</View><View style={styles.artifactCopy}><Text numberOfLines={2} style={styles.fileName}>{descriptor.name}</Text><Text numberOfLines={1} style={styles.fileMeta}>{descriptor.mimeType} · {formatBytes(descriptor.sizeBytes)}</Text></View></View>
    <View style={styles.progressRow}><Text style={[styles.statusText, unknown && styles.errorText]}>{state}</Text>{download?.state === 'downloading' && <Text style={styles.statusText}>{progress}% · {formatBytes(download.receivedBytes)} / {formatBytes(download.totalBytes)}</Text>}</View>
    {download?.state === 'downloading' && <View accessibilityRole="progressbar" accessibilityLabel={`${descriptor.name} 下载进度 ${progress}%`} accessibilityValue={{ min: 0, max: 100, now: progress }} style={styles.progressTrack}><View style={[styles.progressFill, { width: `${progress}%` }]}/></View>}
    <View style={styles.actions}>
      {unknown ? <ActionButton label="查询状态" icon={<RefreshCw size={15} color={color.green}/>} disabled={busy} onPress={onStatus}/>
        : download?.state === 'downloading' ? <ActionButton label="暂停" icon={<Pause size={15} color={color.ink}/>} disabled={busy} onPress={onPause}/>
          : download?.state === 'paused' ? <ActionButton label="继续" icon={<Play size={15} color={color.green}/>} disabled={busy} onPress={onDownload}/>
            : download?.state === 'ready' ? <><ActionButton label="预览" icon={<Eye size={15} color={color.green}/>} disabled={busy} onPress={onPreview}/><ActionButton label="分享" icon={<Share2 size={15} color={color.green}/>} disabled={busy} onPress={onShare}/></>
              : <ActionButton label="下载" icon={<Download size={15} color={color.green}/>} disabled={busy} onPress={onDownload}/>}
      {busy && <ActivityIndicator size="small" color={color.green}/>}
      {(download?.state === 'ready' || download?.state === 'paused') && !unknown && !removeConfirm && <ActionButton label="移除本机副本" icon={<Trash2 size={15} color={color.muted}/>} disabled={busy} onPress={onRemove}/>}
      {removeConfirm && <View style={styles.removeConfirm}><Text style={styles.removeConfirmText}>只移除此设备上的下载文件？</Text><Pressable accessibilityRole="button" accessibilityLabel="确认移除本机副本" disabled={busy} onPress={onRemoveConfirm}><Text style={styles.removeConfirmAction}>确认</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="取消移除" onPress={onRemoveCancel}><Text style={styles.removeCancel}>取消</Text></Pressable></View>}
    </View>
  </View>;
}

function ActionButton({ label, icon, disabled, onPress }: { label: string; icon: React.ReactNode; disabled: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.actionButton, disabled && styles.disabled]}>{icon}<Text style={styles.actionText}>{label}</Text></Pressable>;
}

function InlineNotice({ notice }: { notice: { text: string; code?: string } }) {
  const [expanded, setExpanded] = useState(false);
  return <View accessibilityRole="alert" style={styles.notice}><Text style={styles.noticeText}>{notice.text}</Text>{notice.code && <><Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded((value) => !value)} style={styles.noticeDetails}><Text style={styles.moreText}>{expanded ? '隐藏详情' : '错误详情'}</Text></Pressable>{expanded && <Text selectable style={styles.errorCode}>错误码：{notice.code}</Text>}</>}</View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#FFFFFF' }, qaBanner: { minHeight: 30, backgroundColor: '#9A541C', paddingHorizontal: 10, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10, flexWrap: 'wrap' }, qaBannerText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' }, qaToggle: { minHeight: 26, paddingHorizontal: 8, justifyContent: 'center', borderRadius: 7, backgroundColor: '#7D4115' }, qaToggleText: { color: '#FFFFFF', fontSize: 10, fontWeight: '700', flexDirection: 'row' }, qaChoices: { flexBasis: '100%', flexDirection: 'row', justifyContent: 'center', gap: 6, paddingBottom: 7 }, qaChoice: { minHeight: 30, paddingHorizontal: 10, justifyContent: 'center', borderRadius: 8, backgroundColor: '#7D4115' }, qaChoiceText: { color: '#FFFFFF', fontSize: 10, fontWeight: '600' },
  header: { minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: color.line, gap: 8 }, headerButton: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' }, headerCopy: { flex: 1 }, headerTitle: { color: color.ink, fontSize: 15, fontWeight: '700' }, headerSubtitle: { marginTop: 2, color: color.muted, fontSize: 11 }, summary: { minHeight: 44, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: color.line }, summaryText: { color: color.ink, fontSize: 12, fontWeight: '600' }, summaryHint: { marginLeft: 'auto', color: color.muted, fontSize: 11 },
  list: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 12, gap: 9 }, artifactCard: { borderWidth: 1, borderColor: color.line, borderRadius: 13, padding: 12, backgroundColor: '#FFFFFF' }, artifactMain: { flexDirection: 'row', alignItems: 'center', gap: 10 }, fileIcon: { width: 38, height: 38, borderRadius: 11, backgroundColor: color.wash, justifyContent: 'center', alignItems: 'center' }, artifactCopy: { flex: 1 }, fileName: { color: color.ink, fontSize: 13, fontWeight: '600', lineHeight: 18 }, fileMeta: { marginTop: 3, color: color.muted, fontSize: 10 }, progressRow: { marginTop: 9, flexDirection: 'row', justifyContent: 'space-between', gap: 10 }, statusText: { color: color.muted, fontSize: 11 }, errorText: { color: color.red }, progressTrack: { height: 4, overflow: 'hidden', marginTop: 6, borderRadius: 2, backgroundColor: color.line }, progressFill: { height: 4, backgroundColor: color.green }, actions: { minHeight: 36, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 7, marginTop: 8 }, actionButton: { minHeight: 36, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, borderRadius: 9, backgroundColor: color.canvas }, actionText: { color: color.ink, fontSize: 11, fontWeight: '600' }, disabled: { opacity: 0.55 }, removeConfirm: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 10 }, removeConfirmText: { color: color.muted, fontSize: 10 }, removeConfirmAction: { color: color.red, fontWeight: '700', fontSize: 11 }, removeCancel: { color: color.ink, fontSize: 11 },
  stateCard: { margin: 16, minHeight: 150, padding: 20, alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1, borderColor: color.line, borderRadius: 14 }, stateTitle: { color: color.ink, fontSize: 14, fontWeight: '700' }, stateDetail: { color: color.muted, fontSize: 12, lineHeight: 18, textAlign: 'center' }, loading: { paddingVertical: 35, alignItems: 'center', gap: 9 }, notice: { marginHorizontal: 14, marginTop: 10, padding: 12, borderRadius: 10, backgroundColor: '#FAEFED' }, noticeText: { color: color.red, fontSize: 12, lineHeight: 18 }, noticeDetails: { minHeight: 30, justifyContent: 'center', alignSelf: 'flex-start' }, moreText: { color: color.green, fontSize: 11, fontWeight: '600' }, errorCode: { color: color.muted, fontSize: 10 }, moreButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center' }, footer: { paddingHorizontal: 15, paddingVertical: 8, color: color.muted, fontSize: 10, lineHeight: 15, borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.line },
});
