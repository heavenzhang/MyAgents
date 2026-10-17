import { StatusBar } from 'expo-status-bar';
import * as Crypto from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { ActivityIndicator, AppState, BackHandler, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft, ArrowUp, ArrowUpRight, ChevronRight, CircleUserRound, FileText, Image as ImageIcon, Mic, MoreHorizontal, Paperclip, Pause, Play, Plus, RefreshCw, Sparkles, X } from 'lucide-react-native';
import { Account, Interaction, NativeAttachment, NativeAttachmentUpload, PendingOperation, QaScenario, RemoteMobileRequest, SessionRequest, Snapshot, SpeechReply, Target, armQaStaleApproval, isFixtureMode, parseSessionReply, qaScenarioOptions, requestMobile, requestNative, selectQaScenario, subscribeAttachmentUploadChanges, subscribeSpeechChanges } from '../native';
import { approvalStillCurrent, commitIfViewOwned, createPollFlightGate, createRouteFocusGate, createSingleFlightPoll, draftKey, viewStillOwned, ViewOwner } from '../operationPolicy';
import { DraftPersistence, DraftUpdate } from '../draftPersistence';
import { blocksMutationForScope, permitsLegacyTextFallback, receiptProtocol, reconcileFailedMutation, sendProtocol, type MobileMode, type MutationAttempt } from '../mobilePolicy';
import { SerialUploadQueue } from '../uploadQueue';
import { AttachmentUploadTracker, isConfirmedUploadRecordAbsence } from '../attachmentUploadTracker';

const C = { ink: '#202522', muted: '#747B76', line: '#E7EAE7', paper: '#FFFFFF', canvas: '#F7F8F6', green: '#26734D', greenWash: '#E9F3EC', red: '#A13E38', amber: '#8B6A29' };
type SessionRow = { sessionId: string; title: string; updatedAt: string; preview: string; runtime: string };
type ReceiptStatus = 'processing' | 'accepted' | 'rejected' | 'unconfirmed' | 'not-found' | 'unknown';
type Notice = { tone: 'neutral' | 'error' | 'success'; text: string; code?: string } | null;
type AttachmentItem = { file: NativeAttachment; upload: NativeAttachmentUpload | null; ownerKey: string; errorCode?: string };

const errorMessages: Record<string, string> = {
  MOBILE_RECEIPT_REQUIRED: '设备要求先确认操作状态。请查询状态后再继续；不会自动重发。',
  ON_DEVICE_UNAVAILABLE: '此设备当前没有可用的本地语音识别服务。',
  MICROPHONE_PERMISSION_DENIED: '麦克风权限未开启。可在系统设置中允许后重试。',
  TARGET_UNAVAILABLE: '当前没有可用 Bot，请检查设备连接。',
  ACCOUNT_REPLY_INVALID: '无法读取登录状态，请稍后刷新。',
  SESSION_LIST_REPLY_INVALID: '无法读取会话列表，请稍后重试。',
  SESSION_SNAPSHOT_REPLY_INVALID: '无法读取这条会话，请返回后重试。',
  NATIVE_REPLY_INVALID: '设备返回了无法识别的内容，请稍后重试。',
  MOBILE_PROFILE_MISMATCH: '此设备不支持附件、模型选择或下一步建议；可继续发送纯文本。',
  MOBILE_INTENT_UNSUPPORTED: '此设备不支持附件、模型选择或下一步建议；可继续发送纯文本。',
  METHOD_UNSUPPORTED: '设备不支持这项移动消息能力；能力探测时可回退为纯文本。',
  MOBILE_REMOTE_UNAVAILABLE: '远程服务暂时不可用，请检查连接后重试。',
  MOBILE_ADMISSION_REQUEST_INVALID: '消息格式暂不受支持，请检查文字和附件后重试。',
  MOBILE_ADMISSION_RESPONSE_INVALID: '远程服务返回了无法识别的响应，请稍后重试。',
  MOBILE_CAPABILITY_REQUIRED: '设备能力尚未确认，请刷新后重试。',
  MOBILE_UPLOAD_CANCELLED: '上传已取消。请移除这个附件并重新选择后再发送。',
  MOBILE_ATTACHMENT_LIMIT: '一次最多添加 8 个附件。',
  MOBILE_ATTACHMENT_TOO_LARGE: '附件超过单个文件大小限制。',
  MOBILE_ATTACHMENT_IMAGE_INVALID: '所选图片无法读取或尺寸过大。',
  MOBILE_ATTACHMENT_EMPTY: '所选文件为空，无法上传。',
  MOBILE_ATTACHMENT_UPLOAD_ACTIVE: '附件仍在上传，请先暂停或等待完成。',
  MOBILE_ATTACHMENT_CANCEL_UNCONFIRMED: '取消状态尚未确认；附件仍保留。请查询状态后重试移除。',
  MOBILE_UPLOAD_NOT_FOUND: '设备未找到上传记录。请查询或重新选择附件后重试。',
  MOBILE_ATTACHMENT_UPLOAD_NOT_FOUND: '本机没有这条上传任务记录，可以移除附件后重新选择。',
  MOBILE_ATTACHMENT_NOT_FOUND: '设备未找到本地附件。请重新选择文件。',
  MOBILE_DRAFT_CONFLICT: '草稿版本发生变化；当前编辑已保留。继续编辑后可重试保存。',
};
const receiptLabels: Record<ReceiptStatus | PendingOperation['status'], string> = {
  prepared: '待提交', processing: '处理中', accepted: '已接收', rejected: '未接收',
  unconfirmed: '待确认', 'not-found': '无记录', unknown: '待确认',
};

function attachmentScopeKey(target: Target | null, sessionId: string | null): string | null {
  return target ? JSON.stringify([target.targetId, target.identityKey, target.agentId, sessionId]) : null;
}

function AppBody() {
  const [account, setAccount] = useState<Account | null>(null);
  const [ownerEpoch, setOwnerEpoch] = useState(0);
  const [targets, setTargets] = useState<Target[]>([]);
  const [target, setTarget] = useState<Target | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [pending, setPending] = useState<PendingOperation[]>([]);
  const [screen, setScreen] = useState<'login' | 'sessions' | 'chat'>('login');
  const [draft, setDraft] = useState('');
  const [draftUpdate, setDraftUpdate] = useState<DraftUpdate | null>(null);
  const [composerInputHeight, setComposerInputHeight] = useState(40);
  const [composerTextWidth, setComposerTextWidth] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [mobileMode, setMobileMode] = useState<MobileMode>('loading');
  const [mobileModels, setMobileModels] = useState<{ id: string; label: string }[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [attachmentPicking, setAttachmentPicking] = useState(false);
  const [receiptStates, setReceiptStates] = useState<Record<string, ReceiptStatus>>({});
  const [qaMenuOpen, setQaMenuOpen] = useState(false);
  const [speech, setSpeech] = useState<SpeechReply>({ kind: 'speech', state: 'idle', text: '', final: false });
  const [loginPollGate] = useState(() => createPollFlightGate());
  const [snapshotPollGate] = useState(() => createPollFlightGate());
  const [routeFocusGate] = useState(() => createRouteFocusGate());
  const routeActiveRef = useRef(false);
  const [speechPanelOpen, setSpeechPanelOpen] = useState(false);
  const [loginStarted, setLoginStarted] = useState(false);
  const blocksMutation = blocksMutationForScope(pending, target?.targetId ?? null, snapshot?.sessionId ?? null);
  const scrollRef = useRef<React.ElementRef<typeof ScrollView> | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const targetRef = useRef<Target | null>(null);
  const ownerRef = useRef<ViewOwner>({ epoch: 0, screen: 'login', targetId: null, agentId: null, sessionId: null });
  const activeDraftKeyRef = useRef<string | null>(null);
  const speechDraftKeyRef = useRef<string | null>(null);
  const loadingEpochRef = useRef(0);
  const sendingEpochRef = useRef(0);
  const accountRefreshEpochRef = useRef(0);
  const accountRefreshInFlightRef = useRef<number | null>(null);
  const speechOwnerEpochRef = useRef<number | null>(null);
  const speechStateRef = useRef<SpeechReply['state']>('idle');
  const speechBaseDraftRef = useRef('');
  const appliedSpeechTextRef = useRef('');
  const speechEpochRef = useRef(0);
  const speechActiveRef = useRef(false);
  const accountRef = useRef<Account | null>(null);
  const draftPersistenceRef = useRef<DraftPersistence | null>(null);
  const mobileCatalogEpochRef = useRef(0);
  const attachmentBatchEpochRef = useRef(0);
  const attachmentsRef = useRef<AttachmentItem[]>([]);
  const attachmentQueueRef = useRef(new SerialUploadQueue());
  const attachmentUploadTrackerRef = useRef(new AttachmentUploadTracker());
  const attachmentUploadWaitersRef = useRef(new Map<string, { batchEpoch: number; finish: () => void }>());
  const attachmentScopeRef = useRef<string | null>(null);
  const mobileUnknownAttachmentsRef = useRef(new Map<string, { ownerKey: string; localIds: string[]; targetId: string; identityKey: string; agentId: string; principalId: string | null; sessionId: string | null }>());
  const say = useCallback((text: string, tone: NonNullable<Notice>['tone'] = 'neutral') => {
    if (/^[A-Z][A-Z0-9_]{2,127}$/.test(text)) setNotice({ text: errorMessages[text] ?? '远程操作暂时不可用，请检查连接后重试。', tone, code: text });
    else setNotice({ text, tone });
  }, []);
  useEffect(() => {
    const persistence = new DraftPersistence({
      read: async (targetId, sessionId) => {
        const reply = await requestNative({ version: 1, kind: 'draft.read', targetId, sessionId });
        if (reply.kind === 'error') throw new Error(reply.code);
        if (reply.kind !== 'draft') throw new Error('MOBILE_DRAFT_REPLY_INVALID');
        return reply;
      },
      write: async (targetId, sessionId, expectedRevision, writeId, text) => {
        const reply = await requestNative({ version: 1, kind: 'draft.write', targetId, sessionId, expectedRevision, writeId, text });
        if (reply.kind === 'error') throw new Error(reply.code);
        if (reply.kind !== 'draft') throw new Error('MOBILE_DRAFT_REPLY_INVALID');
        return reply;
      },
    }, (update) => {
      if (activeDraftKeyRef.current !== update.key || ownerRef.current.epoch !== update.ownerEpoch) return;
      setDraft(update.text);
      setDraftUpdate(update);
    }, () => Crypto.randomUUID());
    draftPersistenceRef.current = persistence;
    return () => {
      persistence.clear();
      if (draftPersistenceRef.current === persistence) draftPersistenceRef.current = null;
    };
  }, []);
  const updateAttachments = useCallback((transform: (items: AttachmentItem[]) => AttachmentItem[]) => {
    const next = transform(attachmentsRef.current);
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);
  const releaseAttachmentJob = useCallback((localId: string, batchEpoch?: number) => {
    const waiter = attachmentUploadWaitersRef.current.get(localId);
    if (!waiter || (batchEpoch !== undefined && waiter.batchEpoch !== batchEpoch)) return;
    attachmentUploadWaitersRef.current.delete(localId);
    waiter.finish();
  }, []);
  useEffect(() => subscribeAttachmentUploadChanges((upload) => {
    const currentScope = attachmentScopeRef.current;
    if (!currentScope || targetRef.current?.targetId !== upload.targetId || targetRef.current.identityKey !== upload.identityKey || targetRef.current.agentId !== upload.agentId) return;
    const currentUpload = attachmentUploadTrackerRef.current.publishEvent(upload);
    updateAttachments((items) => items.map((item) => item.ownerKey === currentScope && item.file.localId === currentUpload.localId ? { ...item, upload: currentUpload, errorCode: currentUpload.errorCode ?? undefined } : item));
    if (currentUpload.state === 'ready' || currentUpload.state === 'cancelled' || (currentUpload.errorCode && currentUpload.state !== 'paused')) releaseAttachmentJob(currentUpload.localId);
    if (currentUpload.errorCode) say(currentUpload.errorCode, 'error');
  }), [releaseAttachmentJob, say, updateAttachments]);
  const moveOwner = useCallback((nextScreen: ViewOwner['screen'], nextTarget: Target | null, sessionId: string | null) => {
    const priorOwner = ownerRef.current;
    const priorAttachmentScope = attachmentScopeKey(targetRef.current, priorOwner.sessionId);
    const nextAttachmentScope = attachmentScopeKey(nextTarget, sessionId);
    if (priorAttachmentScope !== nextAttachmentScope) {
      attachmentBatchEpochRef.current += 1;
      attachmentQueueRef.current.invalidate();
      attachmentUploadTrackerRef.current.invalidate();
      for (const item of attachmentsRef.current) {
        if (item.upload?.state === 'uploading') void requestNative({ version: 1, kind: 'attachment.upload.pause', localId: item.file.localId, targetId: item.upload.targetId });
        releaseAttachmentJob(item.file.localId);
      }
      attachmentsRef.current = [];
      setAttachments([]);
      setSelectedModelId(null);
      setSuggestions([]);
    }
    attachmentScopeRef.current = nextAttachmentScope;
    const persistence = draftPersistenceRef.current;
    persistence?.flushOwner(priorOwner.epoch);
    persistence?.deactivate(priorOwner.epoch);
    const key = draftKey(nextTarget, sessionId);
    const priorSnapshot = snapshotRef.current;
    const keepSnapshot = !!sessionId && priorOwner.targetId === nextTarget?.targetId && priorOwner.agentId === nextTarget?.agentId && priorOwner.sessionId === sessionId && priorSnapshot?.sessionId === sessionId;
    targetRef.current = nextTarget;
    snapshotRef.current = keepSnapshot ? priorSnapshot : null;
    ownerRef.current = { epoch: ownerRef.current.epoch + 1, screen: nextScreen, targetId: nextTarget?.targetId ?? null, agentId: nextTarget?.agentId ?? null, sessionId };
    activeDraftKeyRef.current = key;
    setOwnerEpoch(ownerRef.current.epoch);
    loadingEpochRef.current += 1;
    sendingEpochRef.current += 1;
    setLoading(false);
    setSending(false);
    setTarget(nextTarget);
    setScreen(nextScreen);
    setSnapshot(snapshotRef.current);
    setDraftUpdate(null);
    if (nextTarget && key) {
      const activated = persistence?.activate(nextTarget, sessionId, ownerRef.current.epoch);
      if (!activated) { setDraft(''); return ownerRef.current; }
      setDraft(activated.text);
    } else {
      activeDraftKeyRef.current = null;
      setDraft('');
    }
    return ownerRef.current;
  }, [releaseAttachmentJob]);
  const saveDraftFor = useCallback((key: string | null, ownerEpoch: number | null, value: string) => {
    if (ownerEpoch === null) return;
    draftPersistenceRef.current?.edit(key, ownerEpoch, value);
  }, []);
  const saveDraft = useCallback((value: string) => saveDraftFor(activeDraftKeyRef.current, ownerRef.current.epoch, value), [saveDraftFor]);
  const commitSnapshot = useCallback((value: Snapshot) => { if (snapshotRef.current?.revision !== value.revision) setSuggestions([]); snapshotRef.current = value; setSnapshot(value); }, []);
  const onComposerInputLayout = useCallback((event: { nativeEvent: { layout: { width: number } } }) => {
    const width = Math.max(0, event.nativeEvent.layout.width);
    setComposerTextWidth((current) => Math.abs(current - width) > 1 ? width : current);
  }, []);
  const onComposerMeasureLayout = useCallback((event: { nativeEvent: { layout: { height: number } } }) => {
    const height = Math.min(106, Math.max(40, Math.ceil(event.nativeEvent.layout.height)));
    setComposerInputHeight((current) => current === height ? current : height);
  }, []);
  const draftKeyAtRender = activeDraftKeyRef.current;
  const draftOwnerEpochAtRender = ownerRef.current.epoch;

  const applySpeech = useCallback((reply: SpeechReply) => {
    if (!speechActiveRef.current || speechOwnerEpochRef.current !== ownerRef.current.epoch) return;
    speechStateRef.current = reply.state;
    setSpeech(reply);
    const recognizedText = reply.text.trim();
    if (recognizedText && appliedSpeechTextRef.current !== recognizedText) {
      appliedSpeechTextRef.current = recognizedText;
      const base = speechBaseDraftRef.current.trim();
      saveDraft(base ? `${base}\n${recognizedText}` : recognizedText);
    }
    if (reply.code) {
      speechActiveRef.current = false;
      speechStateRef.current = 'idle';
      setSpeech((prior) => ({ ...prior, state: 'idle' }));
      setNotice({ text: errorMessages[reply.code] ?? '本地语音识别暂时不可用，文字草稿已保留。', tone: 'error', code: reply.code });
      return;
    }
    if (reply.final || reply.state === 'idle') { speechActiveRef.current = false; speechStateRef.current = 'idle'; }
  }, [saveDraft]);

  useEffect(() => subscribeSpeechChanges(applySpeech), [applySpeech]);

  const run = useCallback(async (kind: string, action: () => Promise<void>) => {
    const requestOwner = ownerRef.current;
    const requestId = ++loadingEpochRef.current;
    setLoading(true);
    try { await action(); }
    catch (error) { if (viewStillOwned(requestOwner, ownerRef.current)) say(error instanceof Error ? error.message : `NATIVE_${kind.toUpperCase()}_FAILED`, 'error'); }
    finally { if (requestId === loadingEpochRef.current) setLoading(false); }
  }, [say]);

  const retainFailedMutationUntilJournalCheck = async (attempt: MutationAttempt, capturedOwner: ViewOwner, principalId: string | null, error: unknown) => {
    const isCurrentOwner = () => viewStillOwned(capturedOwner, ownerRef.current) && accountRef.current?.principalId === principalId;
    if (!isCurrentOwner()) return;
    setPending((items) => isCurrentOwner() ? reconcileFailedMutation(items, attempt, null) : items);
    setReceiptStates((states) => ({ ...states, [attempt.operationId]: 'unknown' }));
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,127}$/.test(error.message) ? error.message : undefined;
    setNotice({ text: '操作未收到明确回执。已暂时阻止重复发送，正在核对本机操作记录；之后只能查询状态。', tone: 'error', ...(code ? { code } : {}) });
    try {
      const journal = await requestNative({ version: 1, kind: 'operations.pending' });
      if (!isCurrentOwner() || journal.kind !== 'operations') return;
      setPending((items) => isCurrentOwner() ? reconcileFailedMutation(items, attempt, journal.items) : items);
    } catch {
      // Keep the provisional query-only entry if the native journal itself is unavailable.
    }
  };

  const loadMobileCatalog = useCallback(async (selected: Target | null) => {
    const catalogEpoch = ++mobileCatalogEpochRef.current;
    if (!selected?.online) {
      setMobileMode('unavailable'); setMobileModels([]); setSelectedModelId(null); return;
    }
    const stillSelected = () => routeActiveRef.current && AppState.currentState === 'active' && catalogEpoch === mobileCatalogEpochRef.current
      && targetRef.current?.targetId === selected.targetId
      && targetRef.current.identityKey === selected.identityKey;
    setMobileMode('loading'); setMobileModels([]); setSelectedModelId(null); setSuggestions([]);
    let capabilitiesConfirmed = false;
    try {
      const capabilities = await requestMobile(selected.targetId, { version: 1, agentId: selected.agentId, kind: 'mobile.capabilities' });
      if (!stillSelected()) return;
      if (capabilities.kind === 'mobile.error') {
        if (permitsLegacyTextFallback(capabilities.code)) { setMobileMode('legacy'); return; }
        setMobileMode('error'); say(capabilities.code, 'error'); return;
      }
      if (capabilities.kind !== 'mobile.capabilities') { setMobileMode('error'); say('MOBILE_CAPABILITY_REPLY_INVALID', 'error'); return; }
      capabilitiesConfirmed = true;
      setMobileMode('supported');
      const models = await requestMobile(selected.targetId, { version: 1, agentId: selected.agentId, kind: 'mobile.models' });
      if (!stillSelected()) return;
      if (models.kind === 'mobile.models') setMobileModels(models.items);
      else if (models.kind === 'mobile.error') say(models.code, 'error');
      else say('MOBILE_MODELS_REPLY_INVALID', 'error');
    } catch (error) {
      if (stillSelected()) {
        const code = error instanceof Error ? error.message : 'MOBILE_CATALOG_FAILED';
        if (!capabilitiesConfirmed && permitsLegacyTextFallback(code)) { setMobileMode('legacy'); return; }
        setMobileMode('error'); say(code, 'error');
      }
    }
  }, [say]);

  const loadAccount = useCallback(async () => {
    const routeEpoch = routeFocusGate.capture();
    const routeIsCurrent = () => routeFocusGate.isCurrent(routeEpoch) && AppState.currentState === 'active';
    if (!routeIsCurrent()) return;
    const refreshEpoch = ++accountRefreshEpochRef.current;
    accountRefreshInFlightRef.current = refreshEpoch;
    const requestIsCurrent = () => refreshEpoch === accountRefreshEpochRef.current && routeIsCurrent();
    try {
    const reply = await requestNative({ version: 1, kind: 'account.status' });
    if (!requestIsCurrent()) return;
    if (reply.kind !== 'account') throw new Error(reply.kind === 'error' ? reply.code : 'ACCOUNT_REPLY_INVALID');
    const previousAccount = accountRef.current;
    accountRef.current = reply;
    setAccount(reply);
    if (reply.state !== 'signed-in') {
      draftPersistenceRef.current?.clear();
      moveOwner('login', null, null);
      setSessions([]);
      return;
    }
    if (previousAccount && previousAccount.principalId !== reply.principalId) draftPersistenceRef.current?.clear();
    if (!requestIsCurrent()) return;
    const result = await requestNative({ version: 1, kind: 'targets.list' });
    if (!requestIsCurrent()) return;
    if (result.kind !== 'targets') throw new Error(result.kind === 'error' ? result.code : 'TARGETS_REPLY_INVALID');
    setTargets(result.items);
    const previous = targetRef.current;
    const selectedTarget = result.items.find((item) => item.identityKey === previous?.identityKey)
      ?? result.items.find((item) => item.online) ?? result.items[0] ?? null;
    const previousOwner = ownerRef.current;
    const sameLogicalTarget = !!previous && !!selectedTarget && previous.identityKey === selectedTarget.identityKey;
    const nextScreen = previousOwner.screen === 'login' ? 'sessions' : previousOwner.screen;
    const nextSessionId = nextScreen === 'chat' && sameLogicalTarget ? previousOwner.sessionId : null;
    if (previousOwner.screen === 'chat' && !sameLogicalTarget) {
      setNotice({ text: '当前 Bot 已不可用，请从列表重新打开会话。', tone: 'error' });
    }
    const refreshedOwner = moveOwner(nextScreen === 'chat' && !sameLogicalTarget ? 'sessions' : nextScreen, selectedTarget, nextSessionId);
    if (!requestIsCurrent()) return;
    void loadMobileCatalog(selectedTarget);
    if (selectedTarget?.online && refreshedOwner.screen === 'sessions') {
      if (!requestIsCurrent()) return;
      const sessionsReply = parseSessionReply(await requestNative({ version: 1, kind: 'session', targetId: selectedTarget.targetId, request: { kind: 'list', agentId: selectedTarget.agentId, limit: 30 } }));
      if (requestIsCurrent() && viewStillOwned(refreshedOwner, ownerRef.current)) {
        if (sessionsReply.kind === 'error') throw new Error(sessionsReply.code);
        if (sessionsReply.kind !== 'list' || sessionsReply.agentId !== refreshedOwner.agentId) throw new Error('SESSION_LIST_REPLY_INVALID');
        setSessions(sessionsReply.items);
      }
    } else if (refreshedOwner.screen === 'sessions') setSessions([]);
    if (selectedTarget?.online && refreshedOwner.screen === 'chat' && refreshedOwner.sessionId) {
      if (!requestIsCurrent()) return;
      const snapshotReply = parseSessionReply(await requestNative({ version: 1, kind: 'session', targetId: selectedTarget.targetId, request: { kind: 'get', agentId: selectedTarget.agentId, sessionId: refreshedOwner.sessionId, limit: 30 } }));
      if (requestIsCurrent() && viewStillOwned(refreshedOwner, ownerRef.current)) {
        if (snapshotReply.kind === 'error') throw new Error(snapshotReply.code);
        if (snapshotReply.kind !== 'snapshot' || snapshotReply.agentId !== refreshedOwner.agentId || snapshotReply.sessionId !== refreshedOwner.sessionId) throw new Error('SESSION_SNAPSHOT_REPLY_INVALID');
        commitSnapshot(snapshotReply);
      }
    }
    if (!requestIsCurrent()) return;
    const journal = await requestNative({ version: 1, kind: 'operations.pending' });
    if (requestIsCurrent() && journal.kind === 'operations') setPending(journal.items.filter((item) => item.status !== 'prepared'));
    } finally {
      if (accountRefreshInFlightRef.current === refreshEpoch) accountRefreshInFlightRef.current = null;
    }
  }, [commitSnapshot, loadMobileCatalog, moveOwner, routeFocusGate]);

  useFocusEffect(useCallback(() => {
    let active = true;
    routeActiveRef.current = true;
    routeFocusGate.focus();
    void loadAccount().catch((error) => {
      if (active) say(error instanceof Error ? error.message : 'ACCOUNT_LOAD_FAILED', 'error');
    });
    return () => {
      active = false;
      routeActiveRef.current = false;
      routeFocusGate.blur();
      accountRefreshEpochRef.current += 1;
    };
  }, [loadAccount, routeFocusGate, say]));
  useEffect(() => {
    if (loginStarted) {
      const poll = createSingleFlightPoll(async (isCurrent) => {
        try {
          if (!isCurrent()) return;
          const reply = await requestNative({ version: 1, kind: 'account.login.poll' });
          if (!isCurrent() || reply.kind !== 'account') return;
          const previousAccount = accountRef.current;
          if (reply.state !== 'signed-in' || (previousAccount && previousAccount.principalId !== reply.principalId)) draftPersistenceRef.current?.clear();
          accountRef.current = reply;
          setAccount(reply);
          if (reply.state === 'signed-in') { setLoginStarted(false); void loadAccount(); }
        } catch (error) {
          if (isCurrent()) say(error instanceof Error ? error.message : 'ACCOUNT_LOGIN_POLL_FAILED', 'error');
        }
      }, () => routeActiveRef.current && AppState.currentState === 'active', loginPollGate);
      const timer = setInterval(() => { void poll.tick(); }, 3000);
      return () => { clearInterval(timer); poll.stop(); };
    }
  }, [loadAccount, loginPollGate, loginStarted, say]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active' && routeActiveRef.current) void loadAccount().catch((error) => { if (routeActiveRef.current) say(error instanceof Error ? error.message : 'ACCOUNT_LOAD_FAILED', 'error'); });
    });
    return () => listener.remove();
  }, [loadAccount, say]);

  const loadSessions = useCallback(async (selected = targetRef.current) => {
    if (!selected) return;
    const owner = ownerRef.current;
    if (owner.screen !== 'sessions' || owner.targetId !== selected.targetId || owner.agentId !== selected.agentId) return;
    const result = parseSessionReply(await requestNative({ version: 1, kind: 'session', targetId: selected.targetId, request: { kind: 'list', agentId: selected.agentId, limit: 30 } }));
    if (!viewStillOwned(owner, ownerRef.current)) return;
    if (result.kind === 'error') throw new Error(result.code);
    if (result.kind !== 'list' || result.agentId !== owner.agentId) throw new Error('SESSION_LIST_REPLY_INVALID');
    commitIfViewOwned(owner, ownerRef.current, result.items, setSessions);
  }, []);

  useEffect(() => {
    if (screen !== 'chat') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      moveOwner('sessions', targetRef.current, null);
      void loadSessions().catch((error) => say(error instanceof Error ? error.message : 'SESSION_LIST_FAILED', 'error'));
      return true;
    });
    return () => subscription.remove();
  }, [screen, loadSessions, moveOwner, say]);

  const openSnapshot = useCallback(async (row: SessionRow, selected = target) => {
    if (!selected) return;
    const owner = moveOwner('chat', selected, row.sessionId);
    setNotice(null);
    let result;
    try { result = parseSessionReply(await requestNative({ version: 1, kind: 'session', targetId: selected.targetId, request: { kind: 'get', agentId: selected.agentId, sessionId: row.sessionId, limit: 30 } })); }
    catch (error) { if (viewStillOwned(owner, ownerRef.current)) say(error instanceof Error ? error.message : 'SESSION_SNAPSHOT_FAILED', 'error'); return; }
    if (!viewStillOwned(owner, ownerRef.current)) return;
    if (result.kind === 'error') { say(result.code, 'error'); return; }
    if (result.kind !== 'snapshot' || result.agentId !== selected.agentId || result.sessionId !== row.sessionId) { say('SESSION_SNAPSHOT_REPLY_INVALID', 'error'); return; }
    commitIfViewOwned(owner, ownerRef.current, result, commitSnapshot);
  }, [moveOwner, commitSnapshot, say, target]);

  useEffect(() => {
    if (screen !== 'chat' || !snapshot?.sessionId || !target?.targetId) return;
    const pollOwner = ownerRef.current;
    let failureShown = false;
    const poll = createSingleFlightPoll(async (isCurrent) => {
      const current = snapshotRef.current;
      const currentTarget = targetRef.current;
      if (!current || !currentTarget) return;
      const owner = pollOwner;
      if (owner.screen !== 'chat' || owner.targetId !== currentTarget.targetId || owner.agentId !== current.agentId || owner.sessionId !== current.sessionId) return;
      try {
        if (!isCurrent()) return;
        const result = parseSessionReply(await requestNative({ version: 1, kind: 'session', targetId: currentTarget.targetId, request: { kind: 'get', agentId: current.agentId, sessionId: current.sessionId, limit: 30 } }));
        if (!isCurrent() || !viewStillOwned(owner, ownerRef.current)) return;
        if (result.kind === 'snapshot' && result.agentId === owner.agentId && result.sessionId === owner.sessionId) {
          failureShown = false;
          if (result.revision !== snapshotRef.current?.revision) commitIfViewOwned(owner, ownerRef.current, result, commitSnapshot);
        } else if (result.kind === 'error' && !failureShown) {
          failureShown = true;
          say(result.code, 'error');
        }
      } catch (error) {
        if (isCurrent() && viewStillOwned(owner, ownerRef.current) && !failureShown) {
          failureShown = true;
          say(error instanceof Error ? error.message : 'SESSION_SNAPSHOT_FAILED', 'error');
        }
      }
    }, () => routeActiveRef.current && AppState.currentState === 'active' && accountRefreshInFlightRef.current === null && viewStillOwned(pollOwner, ownerRef.current), snapshotPollGate);
    const interval = setInterval(() => {
      void poll.tick();
    }, 1500);
    return () => { clearInterval(interval); poll.stop(); };
  }, [commitSnapshot, ownerEpoch, say, screen, snapshot?.sessionId, snapshotPollGate, target?.targetId]);

  const mutation = async (request: SessionRequest, targetId = target?.targetId) => {
    if (!targetId) throw new Error('TARGET_UNAVAILABLE');
    if (!('operationId' in request)) throw new Error('MUTATION_OPERATION_ID_REQUIRED');
    const mutationOwner = ownerRef.current;
    const principalId = accountRef.current?.principalId ?? null;
    const attempt: MutationAttempt = { protocol: 'session', targetId, agentId: request.agentId, operationId: request.operationId, sessionId: 'sessionId' in request ? request.sessionId : null };
    const sendingId = ++sendingEpochRef.current;
    let receiptReceived = false;
    setSending(true);
    setNotice(null);
    try {
      const result = parseSessionReply(await requestNative({ version: 1, kind: 'session', targetId, request }));
      if (result.kind === 'error') throw new Error(result.code);
      if (result.kind !== 'receipt') throw new Error('MUTATION_RECEIPT_INVALID');
      receiptReceived = true;
      const stillOwner = viewStillOwned(mutationOwner, ownerRef.current);
      setReceiptStates((states) => ({ ...states, [result.operationId]: result.status }));
      if (result.status === 'processing' || result.status === 'unconfirmed' || result.status === 'not-found') setPending((items) => items.some((item) => item.operationId === result.operationId) ? items : [...items, { protocol: 'session', targetId, agentId: request.agentId, operationId: result.operationId, sessionId: result.sessionId, status: result.status === 'processing' ? 'processing' : 'unknown' }]);
      else setPending((items) => items.filter((item) => item.operationId !== result.operationId));
      if (stillOwner && result.status === 'processing') say('已提交，正在确认接收状态');
      else if (stillOwner && result.status === 'accepted') say('已接收');
      else if (stillOwner && result.status === 'unconfirmed') say('结果尚未确认。请查询状态后再继续；这条消息不会自动重发。', 'error');
      else if (stillOwner && result.status === 'not-found') say('未找到该操作记录，无法判断是否执行。请勿直接重发。', 'error');
      else if (stillOwner) say(result.code ?? '操作未接收', 'error');
      if (stillOwner && result.sessionId && request.kind === 'start') {
        const row = { sessionId: result.sessionId, title: request.text.slice(0, 48), updatedAt: new Date().toISOString(), preview: request.text, runtime: target?.runtime ?? '' };
        saveDraft('');
        await openSnapshot(row);
      } else if (stillOwner && request.kind === 'send' && result.status === 'accepted') saveDraft('');
      if (stillOwner && (request.kind === 'respond' || request.kind === 'stop')) {
        const fresh = await requestNative({ version: 1, kind: 'session', targetId, request: { kind: 'get', agentId: request.agentId, sessionId: request.sessionId, limit: 30 } }).then(parseSessionReply);
        if (viewStillOwned(mutationOwner, ownerRef.current) && fresh.kind === 'snapshot' && fresh.agentId === mutationOwner.agentId && fresh.sessionId === mutationOwner.sessionId) commitSnapshot(fresh);
      }
    } catch (error) {
      if (!receiptReceived) await retainFailedMutationUntilJournalCheck(attempt, mutationOwner, principalId, error);
      else if (viewStillOwned(mutationOwner, ownerRef.current) && accountRef.current?.principalId === principalId) say(error instanceof Error ? error.message : 'MUTATION_FAILED', 'error');
    }
    finally { if (sendingId === sendingEpochRef.current) setSending(false); }
  };

  const sendMobile = async (request: Extract<RemoteMobileRequest, { kind: 'mobile.start' | 'mobile.send' }>) => {
    const selected = targetRef.current;
    if (!selected || !selected.online) return;
    const requestOwner = ownerRef.current;
    const principalId = accountRef.current?.principalId ?? null;
    const attempt: MutationAttempt = { protocol: 'mobile', targetId: selected.targetId, agentId: request.agentId, operationId: request.operationId, sessionId: request.kind === 'mobile.send' ? request.sessionId : null };
    const sendingId = ++sendingEpochRef.current;
    const sendOwnerKey = attachmentScopeRef.current ?? '';
    const sendPrincipalId = accountRef.current?.principalId ?? null;
    const localIds = attachmentsRef.current.filter((item) => item.ownerKey === sendOwnerKey).map((item) => item.file.localId);
    let receiptReceived = false;
    setSending(true); setNotice(null);
    try {
      const result = await requestMobile(selected.targetId, request);
      if (result.kind === 'mobile.error') throw new Error(result.code);
      if (result.kind !== 'mobile.receipt' || result.operationId !== request.operationId) throw new Error('MOBILE_RECEIPT_INVALID');
      receiptReceived = true;
      const stillOwner = viewStillOwned(requestOwner, ownerRef.current) && targetRef.current?.identityKey === selected.identityKey;
      setReceiptStates((states) => ({ ...states, [result.operationId]: result.status }));
      if (result.status === 'processing' || result.status === 'unconfirmed' || result.status === 'not-found') {
        setPending((items) => items.some((item) => item.operationId === result.operationId) ? items : [...items, { protocol: 'mobile', targetId: selected.targetId, agentId: request.agentId, operationId: result.operationId, sessionId: result.sessionId, status: result.status === 'processing' ? 'processing' : 'unknown' }]);
        mobileUnknownAttachmentsRef.current.set(result.operationId, { ownerKey: sendOwnerKey, localIds, targetId: selected.targetId, identityKey: selected.identityKey, agentId: selected.agentId, principalId: sendPrincipalId, sessionId: request.kind === 'mobile.send' ? request.sessionId : result.sessionId });
      } else setPending((items) => items.filter((item) => item.operationId !== result.operationId));
      if (stillOwner && result.status === 'processing') say('已提交，正在确认接收状态');
      else if (stillOwner && result.status === 'accepted') say('已接收');
      else if (stillOwner && result.status === 'unconfirmed') say('结果尚未确认。请查询状态后再继续；这条消息和附件不会自动重发。', 'error');
      else if (stillOwner && result.status === 'not-found') say('未找到该操作记录，无法判断是否执行。请勿直接重发。', 'error');
      else if (stillOwner) say(result.code ?? '操作未接收', 'error');
      if (stillOwner && result.status === 'accepted') {
        mobileUnknownAttachmentsRef.current.delete(result.operationId);
        if (request.kind === 'mobile.start') {
          if (!result.sessionId) throw new Error('MOBILE_RECEIPT_SESSION_REQUIRED');
          saveDraft('');
          await cleanupSentAttachments(localIds, sendOwnerKey, selected.identityKey, sendPrincipalId);
          if (!viewStillOwned(requestOwner, ownerRef.current) || targetRef.current?.identityKey !== selected.identityKey) return;
          await openSnapshot({ sessionId: result.sessionId, title: request.text.slice(0, 48) || '新会话', updatedAt: new Date().toISOString(), preview: request.text || '已添加附件', runtime: '' }, selected);
        } else {
          saveDraft('');
          await cleanupSentAttachments(localIds, sendOwnerKey, selected.identityKey, sendPrincipalId);
        }
      }
    } catch (error) {
      if (!receiptReceived) await retainFailedMutationUntilJournalCheck(attempt, requestOwner, principalId, error);
      else if (viewStillOwned(requestOwner, ownerRef.current) && accountRef.current?.principalId === principalId) say(error instanceof Error ? error.message : 'MOBILE_SEND_FAILED', 'error');
    }
    finally { if (sendingId === sendingEpochRef.current) setSending(false); }
  };

  const cleanupSentAttachments = async (localIds: string[], expectedOwnerKey: string, identityKey: string, principalId: string | null) => {
    for (const localId of localIds) {
      if (attachmentScopeRef.current !== expectedOwnerKey || targetRef.current?.identityKey !== identityKey || accountRef.current?.principalId !== principalId) return;
      try {
        const reply = await requestNative({ version: 1, kind: 'attachment.remove', localId });
        if (reply.kind === 'attachment-removed' && attachmentScopeRef.current === expectedOwnerKey && targetRef.current?.identityKey === identityKey && accountRef.current?.principalId === principalId) updateAttachments((items) => items.filter((item) => item.file.localId !== localId));
      } catch { /* A submitted asset is already scoped to its operation; native cleanup can be retried later. */ }
    }
  };

  const sendDraft = () => {
    const text = draft.trim();
    if (!target || sending || blocksMutation) return;
    const plan = sendProtocol(mobileMode, text, selectedModelId, attachments.map((item) => ({ state: item.upload?.state ?? (item.errorCode ? 'error' : 'uploading'), assetId: item.upload?.assetId ?? null })));
    if (plan === 'blocked') {
      if (mobileMode === 'supported' && attachments.some((item) => item.upload?.state !== 'ready' || !item.upload.assetId)) say('请等待所有附件上传完成后再发送。', 'neutral');
      else if (mobileMode === 'legacy' && (attachments.length || selectedModelId)) say('此设备仅支持纯文本消息；请移除附件并取消模型选择。', 'error');
      else if (mobileMode === 'legacy' && text.length > 8000) say('此设备仅支持最多 8,000 个字符的纯文本消息。', 'error');
      return;
    }
    if (plan === 'mobile') {
      if (snapshot) void sendMobile({ version: 1, kind: 'mobile.send', agentId: snapshot.agentId, sessionId: snapshot.sessionId, operationId: Crypto.randomUUID(), text, assetIds: attachments.flatMap((item) => item.upload?.assetId ? [item.upload.assetId] : []), ...(selectedModelId ? { modelId: selectedModelId } : {}) });
      else void sendMobile({ version: 1, kind: 'mobile.start', agentId: target.agentId, operationId: Crypto.randomUUID(), text, assetIds: attachments.flatMap((item) => item.upload?.assetId ? [item.upload.assetId] : []), ...(selectedModelId ? { modelId: selectedModelId } : {}) });
      return;
    }
    if (plan !== 'legacy' || !text) return;
    const operationId = Crypto.randomUUID();
    if (snapshot) void mutation({ kind: 'send', agentId: snapshot.agentId, sessionId: snapshot.sessionId, operationId, text });
    else void mutation({ kind: 'start', agentId: target.agentId, operationId, text });
  };

  const setAttachmentItem = (localId: string, transform: (item: AttachmentItem) => AttachmentItem) => updateAttachments((items) => items.map((item) => item.file.localId === localId ? transform(item) : item));
  const isAttachmentOwnerCurrent = (owner: ViewOwner, selected: Target, scopeKey: string, batchEpoch: number, isQueueCurrent: () => boolean) =>
    isQueueCurrent() && batchEpoch === attachmentBatchEpochRef.current && viewStillOwned(owner, ownerRef.current)
      && attachmentScopeRef.current === scopeKey && targetRef.current?.identityKey === selected.identityKey;
  const waitForUploadResolution = (file: NativeAttachment, selected: Target, batchEpoch: number): Promise<void> => new Promise((resolve) => {
    const current = attachmentsRef.current.find((item) => item.file.localId === file.localId);
    const upload = attachmentUploadTrackerRef.current.current(file.localId);
    if (!current || upload?.targetId === selected.targetId && upload.identityKey === selected.identityKey && upload.agentId === selected.agentId
      && (upload.state === 'ready' || upload.state === 'cancelled' || (upload.errorCode && upload.state !== 'paused'))) { resolve(); return; }
    attachmentUploadWaitersRef.current.set(file.localId, { batchEpoch, finish: resolve });
  });
  const applyUploadReply = (reply: unknown, file: NativeAttachment, selected: Target): NativeAttachmentUpload => {
    if (!reply || typeof reply !== 'object') throw new Error('MOBILE_ATTACHMENT_REPLY_INVALID');
    const envelope = reply as { kind?: string; code?: string };
    if (envelope.kind === 'error') throw new Error(envelope.code ?? 'MOBILE_ATTACHMENT_UPLOAD_FAILED');
    const parsed = reply as Partial<NativeAttachmentUpload>;
    if (parsed.kind !== 'attachment-upload' || parsed.localId !== file.localId || parsed.targetId !== selected.targetId || parsed.identityKey !== selected.identityKey || parsed.agentId !== selected.agentId) throw new Error('MOBILE_ATTACHMENT_REPLY_INVALID');
    return parsed as NativeAttachmentUpload;
  };
  const uploadAttachment = async (file: NativeAttachment, owner: ViewOwner, selected: Target, scopeKey: string, batchEpoch: number, isQueueCurrent: () => boolean) => {
    if (!isAttachmentOwnerCurrent(owner, selected, scopeKey, batchEpoch, isQueueCurrent) || !attachmentsRef.current.some((item) => item.file.localId === file.localId && item.ownerKey === scopeKey)) return;
    setAttachmentItem(file.localId, (item) => ({ ...item, errorCode: undefined }));
    try {
      let upload: NativeAttachmentUpload;
      try {
        const flight = attachmentUploadTrackerRef.current.captureFlight(file.localId);
        const reply = await requestNative({ version: 1, kind: 'attachment.upload', localId: file.localId, targetId: selected.targetId });
        if (!isAttachmentOwnerCurrent(owner, selected, scopeKey, batchEpoch, isQueueCurrent)) return;
        const current = attachmentUploadTrackerRef.current.publishReply(applyUploadReply(reply, file, selected), flight);
        if (!current) return;
        upload = current;
      } catch (startError) {
        const startCode = startError instanceof Error ? startError.message : 'MOBILE_ATTACHMENT_UPLOAD_FAILED';
        if (!isAttachmentOwnerCurrent(owner, selected, scopeKey, batchEpoch, isQueueCurrent)) return;
        // A transport failure can follow durable upload creation; status decides whether the native single-upload slot is still occupied.
        try {
          const flight = attachmentUploadTrackerRef.current.captureFlight(file.localId);
          const status = await requestNative({ version: 1, kind: 'attachment.upload.status', localId: file.localId, targetId: selected.targetId });
          if (!isAttachmentOwnerCurrent(owner, selected, scopeKey, batchEpoch, isQueueCurrent)) return;
          const current = attachmentUploadTrackerRef.current.publishReply(applyUploadReply(status, file, selected), flight);
          if (!current) return;
          upload = current;
        } catch (statusError) {
          const statusCode = statusError instanceof Error ? statusError.message : 'MOBILE_ATTACHMENT_STATUS_FAILED';
          if (!isAttachmentOwnerCurrent(owner, selected, scopeKey, batchEpoch, isQueueCurrent)) return;
          setAttachmentItem(file.localId, (item) => ({ ...item, errorCode: statusCode })); say(statusCode, 'error');
          if (isConfirmedUploadRecordAbsence(statusCode) || startCode === 'MOBILE_UPLOAD_CANCELLED') { releaseAttachmentJob(file.localId, batchEpoch); return; }
          await waitForUploadResolution(file, selected, batchEpoch);
          return;
        }
      }
      if (!isAttachmentOwnerCurrent(owner, selected, scopeKey, batchEpoch, isQueueCurrent)) return;
      setAttachmentItem(file.localId, (item) => ({ ...item, upload, errorCode: upload.errorCode ?? undefined }));
      if (upload.errorCode) say(upload.errorCode, 'error');
      if (upload.state === 'ready' || upload.state === 'cancelled' || (upload.errorCode && upload.state !== 'paused')) releaseAttachmentJob(file.localId, batchEpoch);
      else await waitForUploadResolution(file, selected, batchEpoch);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'MOBILE_ATTACHMENT_UPLOAD_FAILED';
      if (isAttachmentOwnerCurrent(owner, selected, scopeKey, batchEpoch, isQueueCurrent)) {
        setAttachmentItem(file.localId, (item) => ({ ...item, errorCode: code })); say(code, 'error');
        if (code === 'MOBILE_UPLOAD_CANCELLED' || isConfirmedUploadRecordAbsence(code) || code === 'MOBILE_ATTACHMENT_TOO_LARGE' || code === 'MOBILE_ATTACHMENT_IMAGE_INVALID') releaseAttachmentJob(file.localId, batchEpoch);
        else await waitForUploadResolution(file, selected, batchEpoch);
      }
    }
  };

  const queueAttachmentUpload = (file: NativeAttachment, owner: ViewOwner, selected: Target, scopeKey: string) => {
    const batchEpoch = attachmentBatchEpochRef.current;
    const queueEpoch = attachmentQueueRef.current.currentEpoch();
    void attachmentQueueRef.current.enqueue(queueEpoch, (isQueueCurrent) => uploadAttachment(file, owner, selected, scopeKey, batchEpoch, isQueueCurrent)).catch(() => undefined);
  };

  const resumeAttachment = async (item: AttachmentItem, owner: ViewOwner, selected: Target) => {
    const batchEpoch = attachmentBatchEpochRef.current;
    const scopeKey = item.ownerKey;
    try {
      const flight = attachmentUploadTrackerRef.current.captureFlight(item.file.localId);
      const reply = await requestNative({ version: 1, kind: 'attachment.upload', localId: item.file.localId, targetId: selected.targetId });
      if (!isAttachmentOwnerCurrent(owner, selected, scopeKey, batchEpoch, () => true)) return;
      const upload = attachmentUploadTrackerRef.current.publishReply(applyUploadReply(reply, item.file, selected), flight);
      if (!upload) return;
      setAttachmentItem(item.file.localId, (prior) => ({ ...prior, upload, errorCode: upload.errorCode ?? undefined }));
      if (upload.errorCode) say(upload.errorCode, 'error');
      if (upload.state === 'ready' || upload.state === 'cancelled' || (upload.errorCode && upload.state !== 'paused')) releaseAttachmentJob(item.file.localId, batchEpoch);
    } catch (error) {
      if (!isAttachmentOwnerCurrent(owner, selected, scopeKey, batchEpoch, () => true)) return;
      const code = error instanceof Error ? error.message : 'MOBILE_ATTACHMENT_UPLOAD_FAILED';
      setAttachmentItem(item.file.localId, (prior) => ({ ...prior, errorCode: code })); say(code, 'error');
      if (code === 'MOBILE_UPLOAD_CANCELLED' || isConfirmedUploadRecordAbsence(code)) releaseAttachmentJob(item.file.localId, batchEpoch);
    }
  };

  const retryAttachment = (item: AttachmentItem) => {
    if (blocksMutation) { say('请先查询待确认操作状态，再管理这条消息的附件。', 'neutral'); return; }
    const selected = targetRef.current;
    const owner = ownerRef.current;
    if (!selected || item.ownerKey !== attachmentScopeRef.current || item.upload?.state === 'cancelled' || item.errorCode === 'MOBILE_UPLOAD_CANCELLED') {
      say('此上传已取消，请移除并重新选择附件。', 'error'); return;
    }
    if (item.upload?.state === 'paused' || attachmentUploadWaitersRef.current.has(item.file.localId)) void resumeAttachment(item, owner, selected);
    else queueAttachmentUpload(item.file, owner, selected, item.ownerKey);
  };

  const pickAttachment = async (source: 'file' | 'image') => {
    if (blocksMutation) { say('请先查询待确认操作状态，再添加附件。', 'neutral'); return; }
    const selected = targetRef.current;
    const owner = ownerRef.current;
    const scopeKey = attachmentScopeKey(selected, owner.sessionId);
    if (!selected || !scopeKey || mobileMode !== 'supported' || !selected.online) { say(mobileMode === 'legacy' ? '此设备仅支持纯文本消息。' : '设备当前不可用，无法添加附件。', 'error'); return; }
    setAttachmentPicking(true);
    const batchEpoch = attachmentBatchEpochRef.current;
    try {
      const reply = await requestNative({ version: 1, kind: 'attachment.pick', source });
      if (reply.kind === 'error') throw new Error(reply.code);
      if (reply.kind !== 'attachment') throw new Error('MOBILE_ATTACHMENT_REPLY_INVALID');
      if (batchEpoch !== attachmentBatchEpochRef.current || !viewStillOwned(owner, ownerRef.current) || attachmentScopeRef.current !== scopeKey) {
        await requestNative({ version: 1, kind: 'attachment.remove', localId: reply.localId });
        return;
      }
      const next = [...attachmentsRef.current, { file: reply, upload: null, ownerKey: scopeKey }];
      if (next.length > 8) { await requestNative({ version: 1, kind: 'attachment.remove', localId: reply.localId }); throw new Error('MOBILE_ATTACHMENT_LIMIT'); }
      updateAttachments(() => next);
      setComposerMenuOpen(false);
      queueAttachmentUpload(reply, owner, selected, scopeKey);
    } catch (error) {
      if (viewStillOwned(owner, ownerRef.current)) say(error instanceof Error ? error.message : 'MOBILE_ATTACHMENT_PICK_FAILED', 'error');
    } finally {
      if (viewStillOwned(owner, ownerRef.current)) setAttachmentPicking(false);
    }
  };

  const pauseAttachment = async (item: AttachmentItem) => {
    if (blocksMutation) { say('请先查询待确认操作状态，再管理这条消息的附件。', 'neutral'); return; }
    if (!item.upload || !target) return;
    const owner = ownerRef.current;
    const selected = targetRef.current;
    if (!selected) return;
    try {
      const flight = attachmentUploadTrackerRef.current.captureFlight(item.file.localId);
      const reply = await requestNative({ version: 1, kind: 'attachment.upload.pause', localId: item.file.localId, targetId: item.upload.targetId });
      if (reply.kind === 'error') throw new Error(reply.code);
      if (reply.kind !== 'attachment-upload' || reply.localId !== item.file.localId || reply.targetId !== item.upload.targetId
        || reply.identityKey !== item.upload.identityKey || reply.agentId !== item.upload.agentId) throw new Error('MOBILE_ATTACHMENT_REPLY_INVALID');
      if (!viewStillOwned(owner, ownerRef.current) || targetRef.current?.identityKey !== selected.identityKey) return;
      const projection = attachmentUploadTrackerRef.current.publishReply(reply, flight);
      if (projection && viewStillOwned(owner, ownerRef.current)) setAttachmentItem(item.file.localId, (prior) => ({ ...prior, upload: projection, errorCode: projection.errorCode ?? undefined }));
    } catch (error) { if (viewStillOwned(owner, ownerRef.current)) { const code = error instanceof Error ? error.message : 'MOBILE_ATTACHMENT_PAUSE_FAILED'; setAttachmentItem(item.file.localId, (prior) => ({ ...prior, errorCode: code })); say(code, 'error'); } }
  };

  const removeAttachment = async (item: AttachmentItem) => {
    if (blocksMutation) { say('请先查询待确认操作状态，再管理这条消息的附件。', 'neutral'); return; }
    const owner = ownerRef.current;
    const principalId = accountRef.current?.principalId ?? null;
    const selectedIdentityKey = targetRef.current?.identityKey;
    try {
      const hasActiveJob = attachmentUploadWaitersRef.current.has(item.file.localId);
      if ((item.upload || hasActiveJob) && item.upload?.state !== 'cancelled' && item.upload?.state !== 'ready') {
        const selectedTargetId = item.upload?.targetId ?? targetRef.current?.targetId;
        if (!selectedTargetId) throw new Error('TARGET_UNAVAILABLE');
        const selected = targetRef.current;
        if (!selected) throw new Error('TARGET_UNAVAILABLE');
        const flight = attachmentUploadTrackerRef.current.captureFlight(item.file.localId);
        const cancelled = await requestNative({ version: 1, kind: 'attachment.upload.cancel', localId: item.file.localId, targetId: selectedTargetId });
        if (!viewStillOwned(owner, ownerRef.current) || !selectedIdentityKey || targetRef.current?.identityKey !== selectedIdentityKey || accountRef.current?.principalId !== principalId) return;
        if (cancelled.kind === 'error') {
          if (!isConfirmedUploadRecordAbsence(cancelled.code)) throw new Error(cancelled.code);
          releaseAttachmentJob(item.file.localId, attachmentBatchEpochRef.current);
        } else {
          const selected = targetRef.current;
          if (cancelled.kind !== 'attachment-upload' || cancelled.localId !== item.file.localId || cancelled.targetId !== selectedTargetId
            || !selected || cancelled.identityKey !== selected.identityKey || cancelled.agentId !== selected.agentId) throw new Error('MOBILE_ATTACHMENT_CANCEL_UNCONFIRMED');
          const projection = attachmentUploadTrackerRef.current.publishReply(cancelled, flight);
          if (!projection) return;
          if (projection.state === 'paused' && !projection.errorCode) {
            const final = await attachmentUploadTrackerRef.current.wait({ localId: projection.localId, targetId: projection.targetId, identityKey: projection.identityKey, agentId: projection.agentId, uploadId: projection.uploadId }, true);
            if (!final) throw new Error('MOBILE_ATTACHMENT_CANCEL_UNCONFIRMED');
            if (final.errorCode) throw new Error(final.errorCode);
            if (final.state !== 'cancelled' && final.state !== 'ready') throw new Error('MOBILE_ATTACHMENT_CANCEL_UNCONFIRMED');
          } else if (projection.errorCode) throw new Error(projection.errorCode);
          else if (projection.state !== 'cancelled' && projection.state !== 'ready') throw new Error('MOBILE_ATTACHMENT_CANCEL_UNCONFIRMED');
          releaseAttachmentJob(item.file.localId, attachmentBatchEpochRef.current);
        }
      }
      if (!viewStillOwned(owner, ownerRef.current) || !selectedIdentityKey || targetRef.current?.identityKey !== selectedIdentityKey || accountRef.current?.principalId !== principalId) return;
      const removed = await requestNative({ version: 1, kind: 'attachment.remove', localId: item.file.localId });
      if (removed.kind === 'error') throw new Error(removed.code);
      if (removed.kind !== 'attachment-removed') throw new Error('MOBILE_ATTACHMENT_REMOVE_INVALID');
      releaseAttachmentJob(item.file.localId, attachmentBatchEpochRef.current);
      if (viewStillOwned(owner, ownerRef.current)) updateAttachments((items) => items.filter((entry) => entry.file.localId !== item.file.localId));
    } catch (error) { if (viewStillOwned(owner, ownerRef.current)) { const code = error instanceof Error ? error.message : 'MOBILE_ATTACHMENT_REMOVE_FAILED'; setAttachmentItem(item.file.localId, (prior) => ({ ...prior, errorCode: code })); say(code, 'error'); } }
  };

  const fetchSuggestions = async () => {
    const selected = targetRef.current;
    const current = snapshotRef.current;
    const owner = ownerRef.current;
    if (!selected || !current || mobileMode !== 'supported') { say('下一步建议需要已连接且支持建议的会话。', 'neutral'); return; }
    setSuggestionsLoading(true);
    setSuggestions([]);
    try {
      const result = await requestMobile(selected.targetId, { version: 1, kind: 'mobile.suggestions', agentId: current.agentId, sessionId: current.sessionId, revision: current.revision });
      if (!viewStillOwned(owner, ownerRef.current) || snapshotRef.current?.revision !== current.revision) return;
      if (result.kind === 'mobile.error') throw new Error(result.code);
      if (result.kind !== 'mobile.suggestions' || result.sessionId !== current.sessionId || result.revision !== current.revision) throw new Error('MOBILE_SUGGESTIONS_REPLY_INVALID');
      setSuggestions(result.suggestions);
    } catch (error) { if (viewStillOwned(owner, ownerRef.current)) say(error instanceof Error ? error.message : 'MOBILE_SUGGESTIONS_FAILED', 'error'); }
    finally { if (viewStillOwned(owner, ownerRef.current)) setSuggestionsLoading(false); }
  };

  const queryPending = async (item: PendingOperation) => {
    const queryOwner = ownerRef.current;
    const route = receiptProtocol(item);
    let status: ReceiptStatus;
    if (route.kind === 'mobile') {
      const result = await requestMobile(route.targetId, route.request);
      if (result.kind === 'mobile.error') throw new Error(result.code);
      if (result.kind !== 'mobile.receipt' || result.operationId !== item.operationId || (item.sessionId !== null && result.sessionId !== item.sessionId)) throw new Error('MOBILE_RECEIPT_REPLY_INVALID');
      status = result.status;
      if (status === 'accepted') {
        const attached = mobileUnknownAttachmentsRef.current.get(item.operationId);
        const selected = targetRef.current;
        const safeToCleanup = attached && selected?.targetId === attached.targetId && selected.identityKey === attached.identityKey
          && selected.agentId === attached.agentId && accountRef.current?.principalId === attached.principalId
          && item.sessionId === attached.sessionId;
        if (safeToCleanup && attached.ownerKey === attachmentScopeRef.current) { await cleanupSentAttachments(attached.localIds, attached.ownerKey, attached.identityKey, attached.principalId); mobileUnknownAttachmentsRef.current.delete(item.operationId); }
      }
    } else {
      const result = parseSessionReply(await requestNative({ version: 1, kind: 'session', targetId: route.targetId, request: route.request }));
      if (result.kind !== 'receipt' || result.operationId !== item.operationId) throw new Error(result.kind === 'error' ? result.code : 'RECEIPT_REPLY_INVALID');
      status = result.status;
    }
    setReceiptStates((states) => ({ ...states, [item.operationId]: status }));
    if (status === 'accepted' || status === 'rejected') setPending((items) => items.filter((entry) => entry.operationId !== item.operationId));
    if (viewStillOwned(queryOwner, ownerRef.current)) say(status === 'unconfirmed' || status === 'not-found' ? `操作状态：${receiptLabels[status]}，没有重发。` : `操作状态：${receiptLabels[status]}`, status === 'unconfirmed' || status === 'not-found' ? 'error' : 'neutral');
  };

  const respond = (item: Interaction, approved: boolean, answers?: Record<string, string>) => {
    if (!snapshot || !target || !item.actionable || snapshot.state !== 'waiting_user_action') return;
    const generation = snapshot.generation;
    const turnId = snapshot.turnId;
    const approvalOwner = ownerRef.current;
    const captured = { sessionId: snapshot.sessionId, generation, turnId, requestId: item.requestId };
    if (!generation || !turnId) { say('审批信息已过期，请刷新会话。', 'error'); return; }
    void (async () => {
      try {
        if (isFixtureMode) await armQaStaleApproval();
        const current = parseSessionReply(await requestNative({ version: 1, kind: 'session', targetId: target.targetId, request: { kind: 'get', agentId: snapshot.agentId, sessionId: captured.sessionId, limit: 30 } }));
        if (!viewStillOwned(approvalOwner, ownerRef.current)) return;
        if (current.kind !== 'snapshot' || current.agentId !== approvalOwner.agentId || current.sessionId !== approvalOwner.sessionId) throw new Error(current.kind === 'error' ? current.code : 'APPROVAL_REFRESH_INVALID');
        commitSnapshot(current);
        if (!approvalStillCurrent(current, { requestId: captured.requestId, generation, turnId })) { say('审批信息已更新，尚未提交。请检查刷新后的请求。', 'error'); return; }
        void mutation({ kind: 'respond', agentId: current.agentId, sessionId: captured.sessionId, operationId: Crypto.randomUUID(), generation, turnId, requestId: captured.requestId, interaction: item.interaction, approved, ...(answers ? { answers } : {}) });
      } catch (error) { if (viewStillOwned(approvalOwner, ownerRef.current)) say(error instanceof Error ? error.message : 'APPROVAL_REFRESH_FAILED', 'error'); }
    })();
  };

  const startLogin = async () => {
    const reply = await requestNative({ version: 1, kind: 'account.login.start' });
    if (reply.kind !== 'login') throw new Error(reply.kind === 'error' ? reply.code : 'LOGIN_REPLY_INVALID');
    await Linking.openURL(reply.authorizationUrl);
    setLoginStarted(true);
    setAccount((prior) => prior ? { ...prior, state: 'authenticating' } : { kind: 'account', state: 'authenticating', displayName: null, principalId: null });
  };

  const startSpeech = async () => {
    setNotice(null);
    setSpeechPanelOpen(true);
    setSpeech({ kind: 'speech', state: 'idle', text: '', final: false });
    speechBaseDraftRef.current = draft;
    appliedSpeechTextRef.current = '';
    speechDraftKeyRef.current = activeDraftKeyRef.current;
    if (isFixtureMode) { say('Web 演示不能调用设备麦克风；请在开发构建中测试语音。'); return; }
    const epoch = ++speechEpochRef.current;
    speechOwnerEpochRef.current = ownerRef.current.epoch;
    const ownerEpoch = speechOwnerEpochRef.current;
    speechActiveRef.current = true;
    speechStateRef.current = 'recording';
    setSpeech((prior) => ({ ...prior, state: 'recording' }));
    try {
      const reply = await requestNative({ version: 1, kind: 'speech.start' });
      if (epoch !== speechEpochRef.current || ownerEpoch !== ownerRef.current.epoch) return;
      if (reply.kind === 'error') { speechActiveRef.current = false; speechStateRef.current = 'idle'; setSpeech((prior) => ({ ...prior, state: 'idle' })); say(reply.code, 'error'); return; }
      if (reply.kind !== 'speech') { speechActiveRef.current = false; speechStateRef.current = 'idle'; setSpeech((prior) => ({ ...prior, state: 'idle' })); say('SPEECH_REPLY_INVALID', 'error'); return; }
      applySpeech(reply);
    } catch (error) { if (epoch === speechEpochRef.current && ownerEpoch === ownerRef.current.epoch) { speechActiveRef.current = false; speechStateRef.current = 'idle'; setSpeech((prior) => ({ ...prior, state: 'idle' })); say(error instanceof Error ? error.message : 'SPEECH_START_FAILED', 'error'); } }
  };

  const stopSpeech = async () => {
    if (isFixtureMode) return;
    const epoch = speechEpochRef.current;
    const ownerEpoch = speechOwnerEpochRef.current;
    speechStateRef.current = 'transcribing';
    setSpeech((prior) => ({ ...prior, state: 'transcribing', final: false }));
    try {
      const reply = await requestNative({ version: 1, kind: 'speech.stop' });
      if (epoch !== speechEpochRef.current || ownerEpoch !== ownerRef.current.epoch) return;
      if (reply.kind === 'error') { speechActiveRef.current = false; speechStateRef.current = 'idle'; setSpeech((prior) => ({ ...prior, state: 'idle' })); say(reply.code, 'error'); return; }
      if (reply.kind !== 'speech') { speechActiveRef.current = false; speechStateRef.current = 'idle'; setSpeech((prior) => ({ ...prior, state: 'idle' })); say('SPEECH_REPLY_INVALID', 'error'); return; }
      applySpeech(reply);
    } catch (error) { if (epoch === speechEpochRef.current && ownerEpoch === ownerRef.current.epoch) say(error instanceof Error ? error.message : 'SPEECH_STOP_FAILED', 'error'); }
  };

  const cancelSpeech = useCallback(async (quiet = false) => {
    const shouldCancel = speechActiveRef.current || speechStateRef.current !== 'idle';
    const canceledOwnerEpoch = speechOwnerEpochRef.current;
    speechEpochRef.current += 1;
    speechActiveRef.current = false;
    speechOwnerEpochRef.current = null;
    speechStateRef.current = 'idle';
    setSpeech({ kind: 'speech', state: 'idle', text: '', final: false });
    setSpeechPanelOpen(false);
    appliedSpeechTextRef.current = '';
    if (shouldCancel && !isFixtureMode) {
      try {
        const reply = await requestNative({ version: 1, kind: 'speech.cancel' });
        if (reply.kind === 'error' && !quiet && ownerRef.current.epoch === canceledOwnerEpoch) say(reply.code, 'error');
      } catch (error) { if (!quiet && ownerRef.current.epoch === canceledOwnerEpoch) say(error instanceof Error ? error.message : 'SPEECH_CANCEL_FAILED', 'error'); }
    }
  }, [say]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background' && speechActiveRef.current) void cancelSpeech(true);
    });
    return () => subscription.remove();
  }, [cancelSpeech]);

  useEffect(() => {
    if (screen !== 'chat' && speechActiveRef.current) void cancelSpeech(true);
  }, [cancelSpeech, screen]);
  useEffect(() => {
    if (speechActiveRef.current && speechOwnerEpochRef.current !== ownerRef.current.epoch) void cancelSpeech(true);
  }, [cancelSpeech, ownerEpoch]);

  const chooseQaScenario = async (scenario: QaScenario) => {
    moveOwner('login', null, null);
    setSessions([]); setPending([]); setNotice(null);
    setReceiptStates({}); setMenuOpen(false); setComposerMenuOpen(false); setQaMenuOpen(false);
    try { await selectQaScenario(scenario); await loadAccount(); }
    catch (error) { say(error instanceof Error ? error.message : 'NATIVE_SCENARIO_FAILED', 'error'); }
  };
  const sendAvailability = sendProtocol(mobileMode, draft.trim(), selectedModelId, attachments.map((item) => ({ state: item.upload?.state ?? (item.errorCode ? 'error' : 'uploading'), assetId: item.upload?.assetId ?? null })));
  const canSubmit = sendAvailability !== 'blocked' && !!target?.online && !sending && !blocksMutation;
  const chatPendingReceipt = screen === 'chat' ? pending.find((item) => item.status !== 'prepared'
    && item.targetId === target?.targetId && item.agentId === (snapshot?.agentId ?? target?.agentId)
    && item.sessionId === (snapshot?.sessionId ?? null)) : undefined;
  const chatNotice: NonNullable<Notice> | null = chatPendingReceipt
    ? { ...(notice ?? { tone: 'error' as const }), text: `消息状态待确认 · ${receiptLabels[receiptStates[chatPendingReceipt.operationId] ?? chatPendingReceipt.status]}。不会自动重发。` }
    : notice;
  const canQueryChatReceipt = !!target?.online && !loading && !sending;

  return <SafeAreaView style={styles.safe} edges={['top', 'bottom']}><StatusBar style="dark"/><KeyboardAvoidingView style={[styles.fill, styles.appFrame]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    {isFixtureMode && <View accessibilityRole="alert" style={styles.fixtureBanner}><Text style={styles.fixtureText}>演示夹具 · 合成数据 · 草稿为浏览器模拟存储</Text><Pressable accessibilityRole="button" accessibilityLabel="选择 QA 演示场景" onPress={() => setQaMenuOpen((value) => !value)} style={styles.qaScenarioToggle}><Text style={styles.fixtureText}>场景</Text></Pressable>{qaMenuOpen && <View style={styles.qaScenarioOptions}>{qaScenarioOptions.map((item) => <Pressable key={item.id} accessibilityRole="button" onPress={() => void chooseQaScenario(item.id)} style={styles.qaScenarioOption}><Text style={styles.qaScenarioText}>{item.label}</Text></Pressable>)}</View>}</View>}
    {screen === 'login' && <View style={styles.loginPage}>
      <Topbar right={{ label: '刷新', onPress: () => void run('account', loadAccount) }}/>
      <View style={styles.loginCard}>
        <View style={styles.logoMark}><Text style={styles.logoMarkText}>M</Text></View>
        <Text style={styles.title}>连接你的 Agent</Text>
        <Text style={styles.subtitle}>通过已授权的设备打开同一会话。账号凭据由本机安全存储。</Text>
        {!!notice && <NoticeView notice={notice}/>}
        {account?.state === 'authenticating' || loginStarted ? <View style={styles.pendingLogin}><ActivityIndicator color={C.green}/><Text style={styles.body}>等待浏览器完成授权…</Text><Text style={styles.caption}>授权后会自动检查登录状态。</Text></View> : <Pressable accessibilityRole="button" onPress={() => void run('login', startLogin)} style={styles.primaryButton}><Text style={styles.primaryText}>使用浏览器登录</Text></Pressable>}
        {loading && <ActivityIndicator style={{ marginTop: 16 }} color={C.green}/>}
        <Text style={styles.caption}>登录状态不可用时，可以重试刷新。</Text>
      </View>
    </View>}

    {screen === 'sessions' && <View style={styles.fill}>
      <Topbar right={{ label: '刷新', onPress: () => void run('sessions', loadSessions) }} avatar={{ label: '账号与设置', onPress: () => router.push('/account') }}/>
      <View style={styles.targetsBar}>
        <Text style={styles.sectionEyebrow}>BOT</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {targets.map((item) => <Pressable key={item.targetId} accessibilityRole="button" accessibilityLabel={`${item.name}，${item.online ? '在线' : '离线'}`} accessibilityState={{ selected: target?.identityKey === item.identityKey }} onPress={() => { if (targetRef.current?.identityKey !== item.identityKey) { moveOwner('sessions', item, null); setSessions([]); void loadMobileCatalog(item); } void run('sessions', () => loadSessions(item)); }} style={[styles.targetChip, target?.identityKey === item.identityKey && styles.targetChipActive]}><View style={[styles.dot, !item.online && styles.dotOff]}/><Text style={[styles.targetChipText, target?.identityKey === item.identityKey && styles.targetChipTextActive]} numberOfLines={1}>{item.name}</Text></Pressable>)}
          {targets.length === 0 && <Text style={styles.caption}>尚未发现可用 Bot</Text>}
        </ScrollView>
      </View>
      <View style={styles.listHead}><View><Text style={styles.title}>会话</Text><Text style={styles.subtitle}>{target ? `${target.deviceName} · ${target.online ? '在线' : '离线'}` : '选择一个 Bot'}</Text></View><Pressable accessibilityRole="button" onPress={() => { moveOwner('chat', targetRef.current, null); setNotice(null); }} style={styles.newButton}><Text style={styles.newButtonText}>＋ 新会话</Text></Pressable></View>
      {notice && <NoticeView notice={notice}/>}
      <ScrollView style={styles.fill} contentContainerStyle={styles.sessionList}>
        {pending.length > 0 && <View style={styles.pendingBox}><Text style={styles.pendingTitle}>待确认操作</Text><Text style={styles.caption}>状态未知时只查询，不会自动重发。</Text>{pending.map((item) => { const canQuery = !!item.targetId && targets.some((entry) => entry.targetId === item.targetId && entry.online); return <Pressable key={item.operationId} accessibilityRole="button" accessibilityState={{ disabled: !canQuery }} disabled={!canQuery} onPress={() => void run('receipt', () => queryPending(item))} style={[styles.pendingRow, !canQuery && styles.pendingRowDisabled]}><Text style={styles.pendingText}>查询操作 · {receiptLabels[receiptStates[item.operationId] ?? item.status]}</Text><Text style={[styles.pendingLink, !canQuery && styles.pendingLinkDisabled]}>{canQuery ? '查询状态' : '等待设备'}</Text></Pressable>; })}</View>}
        {!target ? <EmptyState title={account?.state === 'signed-in' ? '暂时无法读取 Bot' : '没有可用 Bot'} detail={account?.state === 'signed-in' ? '请检查网络连接后刷新。' : '登录后会从已授权账号读取可连接设备。'}/> : target.online === false ? <EmptyState title="设备当前离线" detail="Bot 设备离线时无法读取会话。"/> : sessions.length === 0 ? <EmptyState title="暂无会话" detail="创建一个会话，或刷新以重新读取。" action="读取会话" onAction={() => void run('sessions', loadSessions)}/> : sessions.map((item) => <Pressable key={item.sessionId} accessibilityRole="button" accessibilityLabel={`打开会话：${item.title || '新会话'}${item.preview ? `，${item.preview}` : ''}`} onPress={() => void run('snapshot', () => openSnapshot(item))} style={styles.sessionRow}><View style={styles.sessionIcon}><ArrowUpRight size={18} color={C.green}/></View><View style={styles.sessionCopy}><Text numberOfLines={1} style={styles.sessionTitle}>{item.title || '新会话'}</Text><Text numberOfLines={2} style={styles.sessionPreview}>{item.preview || item.runtime}</Text></View><ChevronRight size={20} color="#A7AEA9"/></Pressable>)}
      </ScrollView>
    </View>}

    {screen === 'chat' && <View style={styles.fill}>
      <View style={styles.chatToolbar}>
        <Pressable accessibilityRole="button" accessibilityLabel="返回会话列表" onPress={() => { moveOwner('sessions', targetRef.current, null); void run('sessions', loadSessions); }} style={styles.back}><ArrowLeft size={22} color={C.ink}/></Pressable>
        <View style={styles.chatToolbarTitle}><Text numberOfLines={1} style={styles.chatTitle}>{snapshot?.title || '新会话'}</Text><Text numberOfLines={1} style={styles.chatSubtitle}>{target?.name ?? 'Bot'}</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel="更多会话信息" onPress={() => setMenuOpen((value) => !value)} style={styles.toolbarAction}><MoreHorizontal size={22} color={C.ink}/></Pressable>
      </View>
      {menuOpen && <View style={[styles.smallMenu, { flexDirection: 'column', alignItems: 'stretch', gap: 8 }]}><View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Text style={styles.caption}>设备：{target?.deviceName ?? '未知'} · 运行时：{snapshot?.runtime ?? target?.runtime ?? '未知'}</Text><Pressable accessibilityRole="button" accessibilityLabel="关闭会话信息" onPress={() => setMenuOpen(false)}><Text style={styles.pendingLink}>关闭</Text></Pressable></View><Pressable accessibilityRole="button" accessibilityLabel="查看会话成果" disabled={!target?.targetId} onPress={() => { setMenuOpen(false); if (target?.targetId) router.push({ pathname: '/artifacts', params: { targetId: target.targetId, sessionId: snapshot?.sessionId ?? '' } }); }} style={{ minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 8 }}><FileText size={17} color={C.green}/><Text style={styles.pendingLink}>查看会话成果</Text></Pressable></View>}
      {chatNotice && <NoticeView notice={chatNotice} action={chatPendingReceipt ? { label: loading ? '正在查询…' : target?.online ? '查询状态' : '设备离线', accessibilityLabel: '查询这条消息的操作状态', accessibilityHint: '只查询原操作回执，不会重新发送消息', disabled: !canQueryChatReceipt, onPress: () => void run('receipt', () => queryPending(chatPendingReceipt)) } : undefined}/>}
      <ScrollView ref={scrollRef} style={styles.transcript} contentContainerStyle={styles.transcriptContent} keyboardShouldPersistTaps="handled" onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}>
        {!snapshot && <EmptyState title="新建远程会话" detail={target?.online === false ? '设备离线，可先保留草稿，连接后再发送。' : '发送第一条消息后，将为此 Bot 创建新会话。'}/>}
        {snapshot?.state === 'unavailable' && <EmptyState title="会话暂时不可用" detail="请刷新状态或检查设备连接。" action="重新读取" onAction={() => void run('snapshot', () => openSnapshot({ sessionId: snapshot.sessionId, title: snapshot.title, preview: '', updatedAt: '', runtime: snapshot.runtime }))}/>}
        {snapshot?.messages.map((item) => <View key={item.id} style={[styles.messageRow, item.role === 'user' && styles.userMessageRow]}><View style={[styles.messageBubble, item.role === 'user' ? styles.userBubble : styles.assistantBubble]}><Text style={[styles.messageText, item.role === 'user' && styles.userText]}>{item.content}</Text>{item.truncated && <Text style={styles.messageMeta}>内容已截断</Text>}{item.tools.map((tool) => <Text key={tool.id} style={styles.toolText}>{tool.status === 'running' ? '运行中' : tool.status === 'error' ? '失败' : '完成'} · {tool.name}{tool.summary ? ` — ${tool.summary}` : ''}</Text>)}</View><Text style={styles.messageTimestamp}>{formatMessageTime(item.timestamp)}</Text></View>)}
        {snapshot?.state === 'running' && <View style={styles.thinking}><ActivityIndicator color={C.green}/><Text style={styles.caption}>正在处理…</Text></View>}
        {snapshot?.state === 'waiting_user_action' && snapshot.interactions.map((item) => <ApprovalCard key={`${item.generation}:${item.turnId}:${item.requestId}`} item={item} onRespond={respond} disabled={sending || blocksMutation}/>) }
      </ScrollView>
      <View style={styles.composerArea}>
        {composerMenuOpen && <View style={styles.composerMenu}>
          <View style={styles.menuActionRow}>
            <Pressable accessibilityRole="button" accessibilityLabel="从文件中选择附件" accessibilityState={{ disabled: attachmentPicking || mobileMode !== 'supported' || blocksMutation }} disabled={attachmentPicking || mobileMode !== 'supported' || blocksMutation} onPress={() => void pickAttachment('file')} style={styles.menuAction}><Paperclip size={16} color={C.green}/><Text style={styles.menuLabel}>文件</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="从照片中选择附件" accessibilityState={{ disabled: attachmentPicking || mobileMode !== 'supported' || blocksMutation }} disabled={attachmentPicking || mobileMode !== 'supported' || blocksMutation} onPress={() => void pickAttachment('image')} style={styles.menuAction}><ImageIcon size={16} color={C.green}/><Text style={styles.menuLabel}>图片</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="语音输入" onPress={() => { setComposerMenuOpen(false); void startSpeech(); }} style={styles.menuAction}><Mic size={16} color={C.green}/><Text style={styles.menuLabel}>语音</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="获取下一步建议" disabled={suggestionsLoading || mobileMode !== 'supported' || !snapshot} onPress={() => void fetchSuggestions()} style={styles.menuAction}><Sparkles size={16} color={C.green}/><Text style={styles.menuLabel}>建议</Text></Pressable>
          </View>
          {attachmentPicking && <View style={styles.menuStatus}><ActivityIndicator size="small" color={C.green}/><Text style={styles.menuHint}>正在打开系统文件选择器…</Text></View>}
          {mobileMode === 'legacy' && <Text style={styles.menuHint}>此设备仅支持纯文本消息，最多 8,000 个字符。</Text>}
          {mobileMode === 'loading' && <Text style={styles.menuHint}>正在读取设备能力…</Text>}
          {mobileMode === 'error' && <Text style={styles.menuHint}>设备能力暂不可用，请检查连接或稍后重试；附件、模型与建议暂不可用。</Text>}
          {mobileMode === 'supported' && <View style={styles.modelOptions}><Text style={styles.menuSectionLabel}>模型</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.optionChips}>
            <Pressable accessibilityRole="button" accessibilityLabel={`默认模型${selectedModelId === null ? '，已选择' : ''}`} accessibilityState={{ selected: selectedModelId === null }} onPress={() => setSelectedModelId(null)} style={[styles.optionChip, selectedModelId === null && styles.optionChipActive]}><Text style={[styles.optionChipText, selectedModelId === null && styles.optionChipTextActive]}>默认</Text></Pressable>
            {mobileModels.map((model) => <Pressable key={model.id} accessibilityRole="button" accessibilityLabel={`${model.label}${selectedModelId === model.id ? '，已选择' : ''}`} accessibilityState={{ selected: selectedModelId === model.id }} onPress={() => setSelectedModelId(model.id)} style={[styles.optionChip, selectedModelId === model.id && styles.optionChipActive]}><Text style={[styles.optionChipText, selectedModelId === model.id && styles.optionChipTextActive]}>{model.label}</Text></Pressable>)}
          </ScrollView></View>}
          {suggestionsLoading && <View style={styles.menuStatus}><ActivityIndicator size="small" color={C.green}/><Text style={styles.menuHint}>正在读取本轮建议…</Text></View>}
          {suggestions.length > 0 && <View style={styles.suggestionList}><Text style={styles.menuSectionLabel}>下一步建议 · 点击填入草稿</Text>{suggestions.map((suggestion) => <Pressable key={suggestion} accessibilityRole="button" onPress={() => { saveDraft(suggestion); setSuggestions([]); setComposerMenuOpen(false); }} style={styles.suggestionItem}><Text style={styles.suggestionText}>{suggestion}</Text><ArrowUpRight size={15} color={C.green}/></Pressable>)}</View>}
        </View>}
        {speechPanelOpen && <View style={styles.speechPanel}>
          <View style={styles.speechPanelHead}><Text style={styles.speechPanelTitle}>{speech.state === 'recording' ? '正在聆听' : speech.state === 'transcribing' ? '正在整理识别结果' : speech.final ? '识别草稿' : '语音输入'}</Text><Pressable accessibilityRole="button" accessibilityLabel="关闭语音输入" onPress={() => void cancelSpeech()} style={styles.speechClose}><Text style={styles.pendingLink}>关闭</Text></Pressable></View>
          {isFixtureMode && !speech.text ? <Text style={styles.caption}>Web 演示不会生成识别内容；开发构建会使用设备本地语音服务。</Text> : <TextInput accessibilityLabel="语音识别草稿" value={speech.text} editable={speech.state === 'idle'} multiline onChangeText={(value) => { if (speechOwnerEpochRef.current !== ownerRef.current.epoch) return; setSpeech((prior) => ({ ...prior, text: value })); appliedSpeechTextRef.current = value; const base = speechBaseDraftRef.current.trim(); saveDraftFor(speechDraftKeyRef.current, speechOwnerEpochRef.current, base ? `${base}\n${value}` : value); }} placeholder={speech.state === 'recording' ? '正在聆听…' : '识别到的文字会留在这里，发送前可以编辑。'} placeholderTextColor={C.muted} style={styles.speechTextInput}/>}
          <View style={styles.speechActions}>{speech.state === 'recording' ? <Pressable accessibilityRole="button" accessibilityLabel="停止录音并识别" onPress={() => void stopSpeech()} style={styles.speechStop}><Text style={styles.speechStopText}>完成录音</Text></Pressable> : speech.state === 'transcribing' ? <View style={styles.speechProgress}><ActivityIndicator color={C.green}/><Text style={styles.caption}>等待识别完成</Text></View> : <Text style={styles.caption}>{speech.final ? '已加入消息草稿，可继续编辑。' : '识别文本不会自动发送。'}</Text>}</View>
        </View>}
        {(draftUpdate?.message || draftUpdate?.status === 'restoring' || draftUpdate?.status === 'saving') && <View pointerEvents="none" style={styles.draftStatusOverlay}><Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.draftStatus, (draftUpdate.status === 'error' || draftUpdate.status === 'conflict') && styles.draftStatusError]}>{draftUpdate.message ?? (draftUpdate.status === 'restoring' ? '正在恢复草稿…' : '正在保存草稿…')}</Text></View>}
        {attachments.length > 0 && <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.attachmentStrip} contentContainerStyle={styles.attachmentStripContent}>
          {attachments.map((item) => {
            const upload = item.upload;
            const status = upload?.state === 'ready' ? '已就绪' : upload?.state === 'uploading' ? `${Math.min(100, Math.round(upload.receivedBytes / Math.max(upload.totalBytes, 1) * 100))}%` : upload?.state === 'paused' ? '已暂停' : upload?.state === 'cancelled' ? '已取消' : item.errorCode ? (errorMessages[item.errorCode] ? '上传失败' : '需要处理') : '等待上传';
            return <View key={item.file.localId} style={styles.attachmentChip}>
              <View style={styles.attachmentIcon}>{item.file.image ? <ImageIcon size={15} color={C.green}/> : <FileText size={15} color={C.green}/>}</View>
              <View style={styles.attachmentCopy}><Text numberOfLines={1} style={styles.attachmentName}>{item.file.name}</Text><Text style={styles.attachmentStatus}>{status}</Text></View>
              {upload?.state === 'uploading' ? <Pressable accessibilityRole="button" accessibilityLabel={`暂停上传 ${item.file.name}`} accessibilityState={{ disabled: blocksMutation }} disabled={blocksMutation} onPress={() => void pauseAttachment(item)} style={styles.attachmentAction}><Pause size={15} color={C.ink}/></Pressable> : (upload?.state === 'paused' || !!item.errorCode) && upload?.state !== 'cancelled' ? <Pressable accessibilityRole="button" accessibilityLabel={`继续上传 ${item.file.name}`} accessibilityState={{ disabled: blocksMutation }} disabled={blocksMutation} onPress={() => retryAttachment(item)} style={styles.attachmentAction}><Play size={15} color={C.green}/></Pressable> : null}
              <Pressable accessibilityRole="button" accessibilityLabel={`移除附件 ${item.file.name}`} accessibilityState={{ disabled: blocksMutation }} disabled={blocksMutation} onPress={() => void removeAttachment(item)} style={styles.attachmentAction}><X size={15} color={C.muted}/></Pressable>
            </View>;
          })}
        </ScrollView>}
        <View style={styles.composer}>
          <Pressable accessibilityRole="button" accessibilityLabel="更多操作：附件、语音和建议" onPress={() => setComposerMenuOpen((value) => !value)} style={styles.plusButton}><Plus size={21} color={C.ink}/></Pressable>
          <TextInput accessibilityLabel="消息输入框" value={draft} onChangeText={(value) => saveDraftFor(draftKeyAtRender, draftOwnerEpochAtRender, value)} onLayout={onComposerInputLayout} rows={1} placeholder={mobileMode === 'legacy' ? '发送纯文本消息…' : '发送消息…'} placeholderTextColor="#929893" multiline maxLength={mobileMode === 'supported' ? 16000 : 8000} returnKeyType="default" blurOnSubmit={false} style={[styles.input, { height: composerInputHeight }]}/>
          {draft.trim() || attachments.length > 0 ? <Pressable accessibilityRole="button" accessibilityLabel={sending ? '正在提交' : '发送消息'} accessibilityHint={!target?.online ? '设备离线，草稿会保留，连接后再发送。' : blocksMutation ? '请先查询待确认操作状态。' : sendAvailability === 'blocked' ? '请等待所有附件就绪，或检查当前设备支持的发送能力。' : undefined} accessibilityState={{ disabled: !canSubmit }} disabled={!canSubmit} onPress={sendDraft} style={[styles.sendButton, !canSubmit && styles.sendDisabled]}>{sending ? <ActivityIndicator color="#fff" size="small"/> : <ArrowUp size={21} color="#fff" strokeWidth={2.5}/>}</Pressable> : <Pressable accessibilityRole="button" accessibilityLabel={speech.state === 'recording' ? '停止语音输入' : speech.state === 'transcribing' ? '正在识别语音' : '开始语音输入'} disabled={speech.state === 'transcribing'} onPress={() => speech.state === 'recording' ? void stopSpeech() : speech.state === 'transcribing' ? undefined : void startSpeech()} style={styles.micButton}><Mic size={20} color={speech.state === 'recording' ? C.green : C.muted}/></Pressable>}
          {composerTextWidth > 0 && <Text accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden={true} accessible={false} pointerEvents="none" onLayout={onComposerMeasureLayout} style={[styles.inputMeasure, { width: composerTextWidth }]}>{draft ? `${draft}\u200B` : '\u200B'}</Text>}
        </View>
      </View>
    </View>}
  </KeyboardAvoidingView></SafeAreaView>;
}

function Topbar({ right, avatar }: { right?: { label: string; onPress: () => void }; avatar?: { label: string; onPress: () => void } }) {
  return <View style={styles.topbar}>{avatar && <Pressable accessibilityRole="button" accessibilityLabel={avatar.label} onPress={avatar.onPress} hitSlop={6} style={styles.accountAvatar}><CircleUserRound size={22} color={C.green}/></Pressable>}<View style={[styles.brand, !avatar && { marginLeft: 0 }]}><Text style={styles.brandName}>MOXBOTS</Text><Text style={styles.brandSub}>REMOTE</Text></View><View style={styles.headerRight}/>{right && <Pressable accessibilityRole="button" accessibilityLabel={right.label} onPress={right.onPress} style={styles.headerAction}><Text style={styles.headerActionText}>{right.label}</Text></Pressable>}</View>;
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date);
}

function NoticeView({ notice, action }: { notice: NonNullable<Notice>; action?: { label: string; accessibilityLabel: string; accessibilityHint?: string; disabled: boolean; onPress: () => void } }) {
  const [showCode, setShowCode] = useState(false);
  return <View accessibilityRole="alert" style={[styles.notice, notice.tone === 'error' && styles.noticeError, notice.tone === 'success' && styles.noticeSuccess]}>
    <View style={{ flexDirection: action ? 'row' : 'column', alignItems: action ? 'center' : 'flex-start', gap: 8 }}><Text style={[styles.noticeText, action && { flex: 1 }]}>{notice.text}</Text>{action && <Pressable accessibilityRole="button" accessibilityLabel={action.accessibilityLabel} accessibilityHint={action.accessibilityHint} accessibilityState={{ disabled: action.disabled }} disabled={action.disabled} onPress={action.onPress} style={{ minHeight: 40, paddingHorizontal: 6, flexDirection: 'row', alignItems: 'center', gap: 5 }}><RefreshCw size={15} color={action.disabled ? C.muted : C.green}/><Text style={[styles.pendingLink, action.disabled && styles.pendingLinkDisabled]}>{action.label}</Text></Pressable>}</View>
    {notice.code && <Pressable accessibilityRole="button" accessibilityLabel={showCode ? '隐藏错误详情' : '查看错误详情'} onPress={() => setShowCode((value) => !value)} style={styles.errorDetailsButton}><Text style={styles.pendingLink}>{showCode ? '隐藏详情' : '错误详情'}</Text></Pressable>}
    {showCode && notice.code && <Text selectable style={styles.errorCode}>错误码：{notice.code}</Text>}
  </View>;
}
function EmptyState({ title, detail, action, onAction }: { title: string; detail: string; action?: string; onAction?: () => void }) { return <View style={styles.empty}><Text style={styles.emptyTitle}>{title}</Text><Text style={styles.emptyDetail}>{detail}</Text>{action && <Pressable accessibilityRole="button" onPress={onAction} style={styles.secondaryButton}><Text style={styles.secondaryText}>{action}</Text></Pressable>}</View>; }
function ApprovalCard({ item, onRespond, disabled }: { item: Interaction; onRespond: (item: Interaction, approved: boolean, answers?: Record<string, string>) => void; disabled: boolean }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const choose = (key: string, value: string, multiple: boolean) => setAnswers((prior) => {
    const selected = prior[key]?.split('\n').filter(Boolean) ?? [];
    const next = multiple ? selected.includes(value) ? selected.filter((entry) => entry !== value) : [...selected, value] : [value];
    return { ...prior, [key]: next.join('\n') };
  });
  return <View style={styles.approvalCard}><Text style={styles.approvalKicker}>{item.interaction === 'permission' ? '需要授权' : item.interaction === 'plan' ? '等待计划确认' : '需要补充信息'}</Text><Text style={styles.approvalTitle}>{item.title}</Text><Text style={styles.approvalDescription}>{item.description}</Text>{item.questions.map((question) => <View key={question.answerKey} style={styles.questionBlock}><Text style={styles.questionText}>{question.question}</Text>{question.options.length ? <View style={styles.answerOptions}>{question.options.map((option) => { const selected = (answers[question.answerKey]?.split('\n') ?? []).includes(option); return <Pressable key={option} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} disabled={disabled} onPress={() => choose(question.answerKey, option, question.multiSelect)} style={[styles.answerOption, selected && styles.answerOptionSelected]}><Text style={[styles.answerOptionText, selected && styles.answerOptionTextSelected]}>{option}</Text></Pressable>; })}</View> : <TextInput accessibilityLabel={question.question} editable={!disabled} value={answers[question.answerKey] ?? ''} onChangeText={(value) => setAnswers((prior) => ({ ...prior, [question.answerKey]: value }))} placeholder="输入回答" style={styles.answerInput}/>}</View>)}{item.actionable ? <View style={styles.approvalActions}><Pressable accessibilityRole="button" disabled={disabled} onPress={() => onRespond(item, false)} style={styles.denyButton}><Text style={styles.denyText}>{item.interaction === 'permission' ? '拒绝' : '取消'}</Text></Pressable><Pressable accessibilityRole="button" disabled={disabled} onPress={() => onRespond(item, true, item.interaction === 'question' ? answers : undefined)} style={styles.allowButton}><Text style={styles.allowText}>{item.interaction === 'permission' ? '允许一次' : item.interaction === 'plan' ? '确认计划' : '提交回答'}</Text></Pressable></View> : <Text style={styles.caption}>此请求已过期或需在原设备处理。</Text>}</View>;
}

export default function App() { return <SafeAreaProvider><AppBody/></SafeAreaProvider>; }

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.paper }, fill: { flex: 1 }, appFrame: Platform.OS === 'web' ? { width: '100%', maxWidth: 480, alignSelf: 'center', borderLeftWidth: 1, borderRightWidth: 1, borderColor: C.line } : {}, topbar: { height: 54, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line }, back: { width: 44, height: 44, justifyContent: 'center' }, backText: { fontSize: 34, lineHeight: 40, color: C.ink, fontWeight: '300' }, brand: { marginLeft: 4, flexDirection: 'row', alignItems: 'baseline', gap: 7 }, brandName: { color: C.ink, fontSize: 14, fontWeight: '800', letterSpacing: 1.1 }, brandSub: { color: C.muted, fontSize: 9, fontWeight: '700', letterSpacing: 1.4 }, headerRight: { flex: 1 }, headerAction: { marginLeft: 'auto', minWidth: 52, minHeight: 44, justifyContent: 'center', alignItems: 'flex-end' }, headerActionText: { color: C.green, fontSize: 14, fontWeight: '600' }, accountAvatar: { width: 44, height: 44, marginLeft: 10, justifyContent: 'center', alignItems: 'center' },
  loginPage: { flex: 1, backgroundColor: C.canvas }, loginCard: { marginHorizontal: 24, marginTop: 88, padding: 24, borderRadius: 20, backgroundColor: C.paper, borderWidth: 1, borderColor: C.line }, logoMark: { width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: C.greenWash }, logoMarkText: { fontSize: 23, color: C.green, fontWeight: '800' }, title: { marginTop: 18, fontSize: 24, letterSpacing: -0.4, fontWeight: '700', color: C.ink }, subtitle: { marginTop: 6, color: C.muted, fontSize: 14, lineHeight: 21 }, primaryButton: { height: 50, marginTop: 24, borderRadius: 12, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center' }, primaryText: { color: '#fff', fontSize: 15, fontWeight: '700' }, pendingLogin: { alignItems: 'center', paddingVertical: 25, gap: 10 }, body: { color: C.ink, fontSize: 15 }, caption: { color: C.muted, fontSize: 12, lineHeight: 18 },
  targetsBar: { paddingHorizontal: 18, paddingTop: 16, paddingBottom: 10 }, sectionEyebrow: { color: C.muted, fontWeight: '700', fontSize: 10, letterSpacing: 1.2, marginBottom: 9 }, chips: { gap: 8, paddingRight: 18 }, targetChip: { minHeight: 44, maxWidth: 220, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', borderRadius: 22, borderWidth: 1, borderColor: C.line, gap: 8 }, targetChipActive: { borderColor: C.green, backgroundColor: C.greenWash }, targetChipText: { color: C.muted, fontSize: 13, fontWeight: '600' }, targetChipTextActive: { color: C.green }, dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.green }, dotOff: { backgroundColor: '#B5BBB7' },
  listHead: { paddingHorizontal: 20, paddingTop: 13, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, newButton: { height: 44, paddingHorizontal: 14, borderRadius: 12, backgroundColor: C.green, justifyContent: 'center' }, newButtonText: { color: '#fff', fontSize: 13, fontWeight: '700' }, sessionList: { paddingHorizontal: 16, paddingBottom: 30 }, sessionRow: { flexDirection: 'row', alignItems: 'center', minHeight: 78, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: C.line }, sessionIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: C.canvas, alignItems: 'center', justifyContent: 'center' }, sessionIconText: { fontSize: 18, color: C.green }, sessionCopy: { marginLeft: 12, flex: 1 }, sessionTitle: { color: C.ink, fontWeight: '600', fontSize: 15 }, sessionPreview: { color: C.muted, fontSize: 12, marginTop: 5 }, chevron: { marginLeft: 8, color: '#A7AEA9', fontSize: 25 },
  empty: { flex: 1, minHeight: 185, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 30 }, emptyTitle: { color: C.ink, fontSize: 16, fontWeight: '700', textAlign: 'center' }, emptyDetail: { marginTop: 6, maxWidth: 280, color: C.muted, fontSize: 13, lineHeight: 20, textAlign: 'center' }, secondaryButton: { marginTop: 15, paddingHorizontal: 18, height: 42, borderRadius: 11, borderWidth: 1, borderColor: C.line, justifyContent: 'center' }, secondaryText: { color: C.green, fontSize: 13, fontWeight: '600' },
  chatToolbar: { height: 56, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: C.line }, chatToolbarTitle: { flex: 1, paddingLeft: 5, paddingRight: 8 }, chatTitle: { color: C.ink, fontWeight: '700', fontSize: 15 }, chatSubtitle: { marginTop: 1, color: C.muted, fontSize: 11 }, toolbarAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, transcript: { flex: 1 }, transcriptContent: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 24, flexGrow: 1 }, messageRow: { width: '100%', marginBottom: 16, alignItems: 'flex-start' }, userMessageRow: { alignItems: 'flex-end' }, messageBubble: { maxWidth: '90%', paddingHorizontal: 14, paddingVertical: 11, borderRadius: 16 }, assistantBubble: { backgroundColor: C.canvas, borderTopLeftRadius: 5 }, userBubble: { backgroundColor: C.green, borderTopRightRadius: 5 }, messageText: { fontSize: 15, lineHeight: 22, color: C.ink }, userText: { color: '#fff' }, messageMeta: { marginTop: 8, color: '#DDECE2', fontSize: 11 }, messageTimestamp: { marginTop: 4, marginHorizontal: 5, color: '#969D98', fontSize: 10 }, toolText: { marginTop: 7, color: C.muted, fontSize: 12, lineHeight: 18 }, thinking: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 2, marginBottom: 15, marginLeft: 5 },
  composerArea: { position: 'relative', paddingHorizontal: 12, paddingTop: 1, paddingBottom: 1, borderTopWidth: StyleSheet.hairlineWidth, borderColor: C.line, backgroundColor: C.paper }, draftStatusOverlay: { position: 'absolute', zIndex: 3, left: 0, right: 0, bottom: 49, alignItems: 'center' }, draftStatus: { maxWidth: '100%', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 9, backgroundColor: C.canvas, color: C.muted, fontSize: 11, lineHeight: 15, textAlign: 'center' }, draftStatusError: { backgroundColor: '#FBEEEC', color: C.red }, composer: { minHeight: 44, maxHeight: 124, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: C.line, backgroundColor: C.paper, borderRadius: 24, paddingHorizontal: 3, paddingVertical: 1 }, plusButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, input: { flex: 1, maxHeight: 106, minHeight: 40, paddingHorizontal: 6, paddingTop: 10, paddingBottom: 8, color: C.ink, fontSize: 15, lineHeight: 21 }, inputMeasure: { position: 'absolute', left: 47, top: 1, paddingHorizontal: 6, paddingTop: 10, paddingBottom: 8, fontSize: 15, lineHeight: 21, color: 'transparent', opacity: 0 }, micButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, sendButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: C.green }, sendDisabled: { backgroundColor: '#B7C9BD' },
  notice: { marginHorizontal: 16, marginVertical: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, backgroundColor: C.canvas }, noticeError: { backgroundColor: '#FBEEEC' }, noticeSuccess: { backgroundColor: C.greenWash }, noticeText: { color: C.ink, fontSize: 12, lineHeight: 17 }, errorDetailsButton: { alignSelf: 'flex-start', marginTop: 5, minHeight: 28, justifyContent: 'center' }, errorCode: { marginTop: 3, color: C.muted, fontSize: 11 }, approvalCard: { marginVertical: 8, padding: 15, borderRadius: 14, borderWidth: 1, borderColor: '#E9DDBD', backgroundColor: '#FFFCF4' }, approvalKicker: { color: C.amber, fontWeight: '700', fontSize: 11 }, approvalTitle: { marginTop: 6, color: C.ink, fontSize: 15, fontWeight: '700' }, approvalDescription: { marginTop: 5, color: C.muted, fontSize: 13, lineHeight: 19 }, questionText: { marginTop: 10, color: C.ink, fontSize: 13, lineHeight: 20 }, approvalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 12 }, denyButton: { minHeight: 42, paddingHorizontal: 16, justifyContent: 'center' }, denyText: { color: C.red, fontWeight: '600' }, allowButton: { minHeight: 42, paddingHorizontal: 15, justifyContent: 'center', borderRadius: 10, backgroundColor: C.green }, allowText: { color: '#fff', fontWeight: '700' },
  smallMenu: { padding: 12, borderBottomWidth: 1, borderColor: C.line, flexDirection: 'row', justifyContent: 'space-between' }, composerMenu: { marginBottom: 8, padding: 10, backgroundColor: C.canvas, borderRadius: 14 }, menuActionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 }, menuAction: { minHeight: 42, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 10, backgroundColor: C.paper }, menuLabel: { color: C.ink, fontSize: 13 }, menuHint: { color: C.muted, fontSize: 11, lineHeight: 16, marginTop: 5 }, menuStatus: { minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 8 }, menuSectionLabel: { color: C.muted, fontSize: 11, fontWeight: '700', marginBottom: 6 }, modelOptions: { marginTop: 10 }, optionChips: { gap: 6, paddingRight: 10 }, optionChip: { minHeight: 34, paddingHorizontal: 11, justifyContent: 'center', borderWidth: 1, borderColor: C.line, borderRadius: 17, backgroundColor: C.paper }, optionChipActive: { borderColor: C.green, backgroundColor: C.greenWash }, optionChipText: { color: C.muted, fontSize: 11 }, optionChipTextActive: { color: C.green, fontWeight: '700' }, suggestionList: { marginTop: 9 }, suggestionItem: { minHeight: 39, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: StyleSheet.hairlineWidth, borderColor: C.line }, suggestionText: { flex: 1, paddingRight: 10, color: C.ink, fontSize: 12, lineHeight: 17 }, attachmentStrip: { maxHeight: 54, marginBottom: 5 }, attachmentStripContent: { gap: 7, paddingHorizontal: 2, alignItems: 'center' }, attachmentChip: { maxWidth: 240, minHeight: 44, paddingLeft: 8, paddingRight: 4, flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.canvas }, attachmentIcon: { width: 24, alignItems: 'center' }, attachmentCopy: { maxWidth: 125 }, attachmentName: { color: C.ink, fontSize: 11, fontWeight: '600' }, attachmentStatus: { color: C.muted, fontSize: 10, marginTop: 1 }, attachmentAction: { width: 34, height: 38, alignItems: 'center', justifyContent: 'center' }, speechPanel: { marginBottom: 8, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: C.line, backgroundColor: C.canvas }, speechPanelHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, speechPanelTitle: { color: C.ink, fontSize: 13, fontWeight: '700' }, speechClose: { minHeight: 32, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' }, speechTextInput: { marginTop: 8, minHeight: 50, maxHeight: 110, padding: 9, borderRadius: 9, backgroundColor: C.paper, color: C.ink, fontSize: 14, lineHeight: 20 }, speechActions: { minHeight: 38, justifyContent: 'center', alignItems: 'flex-start', marginTop: 5 }, speechStop: { minHeight: 40, minWidth: 110, paddingHorizontal: 14, justifyContent: 'center', alignItems: 'center', borderRadius: 10, backgroundColor: C.green }, speechStopText: { color: C.paper, fontSize: 13, fontWeight: '700' }, speechProgress: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 8 }, pendingBox: { marginTop: 8, marginBottom: 12, padding: 13, borderRadius: 12, backgroundColor: C.canvas }, pendingTitle: { color: C.ink, fontWeight: '700', fontSize: 13 }, pendingRow: { minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: StyleSheet.hairlineWidth, borderColor: C.line, marginTop: 8 }, pendingText: { color: C.muted, fontSize: 12 }, pendingLink: { color: C.green, fontWeight: '600', fontSize: 12 }, pendingRowDisabled: { opacity: 0.55 }, pendingLinkDisabled: { color: C.muted }, fixtureBanner: { minHeight: 27, backgroundColor: '#9A541C', paddingHorizontal: 10, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10, flexWrap: 'wrap' }, fixtureText: { color: '#fff', fontSize: 11, fontWeight: '700' }, qaScenarioToggle: { minHeight: 26, paddingHorizontal: 7, justifyContent: 'center', borderRadius: 7, backgroundColor: '#7D4115' }, qaScenarioOptions: { flexBasis: '100%', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 5, paddingBottom: 7 }, qaScenarioOption: { minHeight: 29, paddingHorizontal: 8, justifyContent: 'center', borderRadius: 8, backgroundColor: '#7D4115' }, qaScenarioText: { color: '#fff', fontSize: 10, fontWeight: '600' }, questionBlock: { marginTop: 10 }, answerOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 7 }, answerOption: { minHeight: 38, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 19, borderWidth: 1, borderColor: C.line, backgroundColor: C.paper }, answerOptionSelected: { borderColor: C.green, backgroundColor: C.greenWash }, answerOptionText: { color: C.muted, fontSize: 12 }, answerOptionTextSelected: { color: C.green, fontWeight: '700' }, answerInput: { minHeight: 42, marginTop: 7, paddingHorizontal: 10, borderWidth: 1, borderColor: C.line, borderRadius: 10, backgroundColor: C.paper, color: C.ink },
});
