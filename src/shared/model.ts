import { z } from 'zod';

export const timeframes = ['1m', '5m', '10m', '15m', '30m', '1h', '1d'] as const;
export type Timeframe = typeof timeframes[number];
export const intervalMs: Record<Timeframe, number> = {
  '1m': 60000, '5m': 300000, '10m': 600000, '15m': 900000,
  '30m': 1800000, '1h': 3600000, '1d': 86400000,
};
export type SourceId = string;
const sourceSchema = z.string().regex(/^[a-z0-9-]{1,40}$/);
export interface Candle {
  openTime: number; closeTime: number;
  open: string; high: string; low: string; close: string; volume: string | null;
  closed: boolean;
}
export const fields = ['open', 'high', 'low', 'close', 'volume', 'ema', 'sma', 'wma',
  'volumeSma', 'stochK', 'stochD', 'macd', 'macdSignal', 'macdHist',
  'highest', 'lowest', 'volumeSum', 'fractalHigh', 'fractalLow', 'legVolumeRatio'] as const;
export type SeriesField = typeof fields[number];
export const operators = ['gt', 'gte', 'lt', 'lte', 'eq', 'crossUp', 'crossDown', 'crossUpTouch', 'crossDownTouch', 'rising', 'falling'] as const;
export type Operator = typeof operators[number];
export interface IndicatorParameters {
  fast?: number; slow?: number; signal?: number; kLength?: number; kSmooth?: number; dSmooth?: number;
  oscillatorMa?: 'sma' | 'ema' | 'wma'; signalMa?: 'sma' | 'ema' | 'wma';
  fractalLookback?: number;
}
export interface SeriesOperand {
  kind: 'series'; field: SeriesField; timeframe: Timeframe; period: number;
  offset: number; factor: string; params?: IndicatorParameters;
}
export type Operand = SeriesOperand | { kind: 'constant'; value: string };
export interface EvaluationWindow {
  anchor: 'current' | 'trigger'; timeframe: Timeframe; from: number; to: number; match: 'any' | 'all';
}
export interface Condition {
  kind: 'condition'; id: string; left: SeriesOperand; operator: Operator;
  right: Operand; bars: number; window?: EvaluationWindow;
}
export interface Group { kind: 'group'; id: string; combinator: 'and' | 'or'; rules: Expression[]; window?: EvaluationWindow }
export type Expression = Condition | Group;
export interface Confirmation {
  id: string; name: string; expression: Expression; policy: 'latch' | 'recheck';
}
export interface TemporalRule {
  mode: 'parallel' | 'sequential'; match: 'all' | 'any'; timeoutBars: number;
  retrigger: 'ignore' | 'replace'; nextBar: boolean;
  confirmations: Confirmation[]; reset?: Expression; completion?: Expression;
  outcomes?: Array<{ id: string; label: string; expression: Expression }>;
  defaultOutcome?: string; unknownOutcome?: string;
}
export interface Signal {
  id: string; pairId: string; name: string; revision: number; enabled: boolean;
  timeframe: Timeframe; cooldownBars: number; expression: Expression; temporal?: TemporalRule;
}
export interface Pair { id: string; code: string; name: string; region: string; source: SourceId }
export type Truth = 'true' | 'false' | 'unknown';
export interface Explanation {
  id: string; result: Truth; label: string; left?: string; right?: string;
  candleTime?: number; children?: Explanation[];
}
export interface SignalEvent {
  id: string; signalId: string; signalName: string; revision: number;
  pairId: string; code: string; source: SourceId; at: number; createdAt: number;
  price: string; explanation: Explanation; triggeredAt?: number; category?: string;
  kind?: 'signal' | 'test' | 'monitoring-started' | 'monitoring-stopped'; reason?: string;
  delivery?: { state: 'pending' | 'sent' | 'failed' | 'paused'; attempts: number; error?: string; sentAt?: number };
}
export interface SignalStatus { signalId: string; state: string; explanation?: Explanation; checkedAt?: number }
export interface ProviderInfo { id: SourceId; name: string; configured: boolean; live: boolean }
export interface AppSettings { monitoring: boolean; activePairId: string; timeframe: Timeframe; telegramEnabled?: boolean; soundEnabled?: boolean; soundVolume?: number }
export interface SavedData { pairs: Pair[]; signals: Signal[]; settings: AppSettings }
export interface AppSnapshot extends SavedData {
  providers: ProviderInfo[]; candles: Candle[]; events: SignalEvent[];
  statuses: SignalStatus[]; feedStatus: string; feedError: string | null;
  marketTime: number; receivedAt: number | null; transport: 'replay' | 'rest' | 'websocket';
  telegramConfigured?: boolean;
  telegramBotStatus?: string;
  telegramConnectionId?: string;
}
export interface TelegramCredentials { token: string; chatId: string }
export const telegramChatSchema = z.string().trim().regex(/^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/, 'Введите числовой Chat ID или @имя канала');
export const telegramTokenSchema = z.string().trim().regex(/^\d+:[A-Za-z0-9_-]{20,200}$/, 'Некорректный токен Telegram-бота');
export const telegramCredentialsSchema = z.object({ token: telegramTokenSchema, chatId: telegramChatSchema });
export const telegramBindingSchema = z.object({ token: telegramTokenSchema, chatId: telegramChatSchema.optional(),
  botUsername: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{4,31}$/).optional(), chatLabel: z.string().max(200).optional(),
  pairingCode: z.string().regex(/^[a-f0-9]{32}$/).optional(), pairingExpiresAt: z.number().safe().positive().optional() });
export type TelegramBinding = z.infer<typeof telegramBindingSchema>;
export interface TelegramChat { id: string; label: string; type: string }

const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/, 'Ожидается десятичное число').max(80);
const seriesSchema: z.ZodType<SeriesOperand> = z.object({
  kind: z.literal('series'), field: z.enum(fields), timeframe: z.enum(timeframes),
  period: z.number().int().min(1).max(500), offset: z.number().int().min(0).max(500), factor: decimal,
  params: z.object({ fast: z.number().int().min(1).max(500).optional(), slow: z.number().int().min(1).max(500).optional(),
    signal: z.number().int().min(1).max(500).optional(), kLength: z.number().int().min(1).max(500).optional(),
    kSmooth: z.number().int().min(1).max(500).optional(), dSmooth: z.number().int().min(1).max(500).optional(),
    oscillatorMa: z.enum(['sma', 'ema', 'wma']).optional(), signalMa: z.enum(['sma', 'ema', 'wma']).optional(),
    fractalLookback: z.number().int().min(1).max(10000).optional(),
  }).optional(),
});
const windowSchema = z.object({ anchor: z.enum(['current', 'trigger']), timeframe: z.enum(timeframes),
  from: z.number().int().min(-10000).max(10000), to: z.number().int().min(-10000).max(10000), match: z.enum(['any', 'all']),
}).superRefine((value, ctx) => {
  if (value.to < value.from || value.to - value.from >= 10000) ctx.addIssue({ code: 'custom', message: 'Окно должно содержать от 1 до 10000 свечей' });
  if (value.anchor === 'current' && value.to > 0) ctx.addIssue({ code: 'custom', message: 'Окно от текущей свечи не может смотреть в будущее' });
});
export const expressionSchema: z.ZodType<Expression> = z.lazy(() => z.union([
  z.object({ kind: z.literal('condition'), id: z.string().min(1).max(80),
    left: seriesSchema, operator: z.enum(operators),
    right: z.union([seriesSchema, z.object({ kind: z.literal('constant'), value: decimal })]),
    bars: z.number().int().min(1).max(100), window: windowSchema.optional(),
  }),
  z.object({ kind: z.literal('group'), id: z.string().min(1).max(80),
    combinator: z.enum(['and', 'or']), rules: z.array(expressionSchema).min(1).max(100), window: windowSchema.optional() }),
]));
export const signalSchema = z.object({
  id: z.string().min(1).max(80), pairId: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(100), revision: z.number().int().positive(),
  enabled: z.boolean(), timeframe: z.enum(timeframes),
  cooldownBars: z.number().int().min(0).max(1000), expression: expressionSchema,
  temporal: z.object({ mode: z.enum(['parallel', 'sequential']), match: z.enum(['all', 'any']),
    timeoutBars: z.number().int().min(0).max(10000), retrigger: z.enum(['ignore', 'replace']), nextBar: z.boolean(),
    confirmations: z.array(z.object({ id: z.string().min(1).max(80), name: z.string().trim().min(1).max(100),
      expression: expressionSchema, policy: z.enum(['latch', 'recheck']) })).min(1).max(20),
    reset: expressionSchema.optional(), completion: expressionSchema.optional(),
    outcomes: z.array(z.object({ id: z.string().min(1).max(80), label: z.string().trim().min(1).max(100), expression: expressionSchema })).min(1).max(10).optional(),
    defaultOutcome: z.string().trim().min(1).max(100).optional(), unknownOutcome: z.string().trim().min(1).max(100).optional(),
  }).optional(),
}).superRefine((signal, context) => {
  try { checkSignalLimits(signal); }
  catch (error) { context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Некорректная схема' }); }
});
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot') }),
  z.object({ type: z.literal('selectPair'), pairId: z.string().max(80) }),
  z.object({ type: z.literal('setTimeframe'), timeframe: z.enum(timeframes) }),
  z.object({ type: z.literal('setMonitoring'), enabled: z.boolean() }),
  z.object({ type: z.literal('setSoundSettings'), enabled: z.boolean(), volume: z.number().int().min(0).max(100) }),
  z.object({ type: z.literal('switchSource'), pairId: z.string().max(80), source: sourceSchema }),
  z.object({ type: z.literal('addPair'), code: z.string().trim().regex(/^[A-Z0-9._-]{2,32}$/), name: z.string().trim().min(1).max(100), region: z.literal('GB'), source: sourceSchema }),
  z.object({ type: z.literal('deletePair'), pairId: z.string().min(1).max(80) }),
  z.object({ type: z.literal('saveSignal'), signal: signalSchema }),
  z.object({ type: z.literal('toggleSignal'), id: z.string().max(80), enabled: z.boolean() }),
  z.object({ type: z.literal('deleteSignal'), id: z.string().max(80) }),
  z.object({ type: z.literal('setSourceToken'), source: sourceSchema, token: z.string().trim().min(10).max(512) }),
  z.object({ type: z.literal('getSourceToken'), source: sourceSchema }),
  z.object({ type: z.literal('getTelegramSettings') }),
  z.object({ type: z.literal('getTelegramToken') }),
  z.object({ type: z.literal('setTelegramSettings'), token: telegramTokenSchema.optional(), chatId: telegramChatSchema }),
  z.object({ type: z.literal('saveTelegramBot'), token: telegramTokenSchema }),
  z.object({ type: z.literal('findTelegramChats') }),
  z.object({ type: z.literal('bindTelegramChat'), chatId: telegramChatSchema }),
  z.object({ type: z.literal('openTelegramBot') }),
  z.object({ type: z.literal('disconnectTelegram') }),
  z.object({ type: z.literal('setTelegramEnabled'), enabled: z.boolean() }),
  z.object({ type: z.literal('testTelegram') }),
  z.object({ type: z.literal('retryTelegram'), eventId: z.string().min(1).max(100) }),
  z.object({ type: z.literal('testSource'), source: sourceSchema }),
  z.object({ type: z.literal('searchPairs'), source: sourceSchema, query: z.string().trim().max(32) }),
]);
export type Command = z.infer<typeof commandSchema>;
export type EngineCommand = Exclude<Command, { type: 'setSourceToken' | 'getSourceToken' | 'getTelegramSettings' | 'getTelegramToken' | 'setTelegramSettings' | 'saveTelegramBot' | 'findTelegramChats' | 'bindTelegramChat' | 'openTelegramBot' | 'disconnectTelegram' }>;
export function isMainCommand(command: Command): command is Exclude<Command, EngineCommand> {
  return ['setSourceToken', 'getSourceToken', 'getTelegramSettings', 'getTelegramToken', 'setTelegramSettings', 'saveTelegramBot', 'findTelegramChats', 'bindTelegramChat', 'openTelegramBot', 'disconnectTelegram'].includes(command.type);
}
export type CommandResult = { ok: true; data?: unknown } | { ok: false; error: string };
export interface DesktopBridge {
  invoke(command: Command): Promise<CommandResult>;
  subscribe(listener: (state: AppSnapshot) => void): () => void;
  subscribeErrors(listener: (error: string) => void): () => void;
  subscribeSound(listener: (volume: number) => void): () => void;
}

export function defaultExpression(): Group {
  return { kind: 'group', id: 'root', combinator: 'and', rules: [{ kind: 'condition', id: 'ema-cross',
    left: { kind: 'series', field: 'ema', timeframe: '5m', period: 5, offset: 0, factor: '1' }, operator: 'crossUp',
    right: { kind: 'series', field: 'ema', timeframe: '5m', period: 10, offset: 0, factor: '1' }, bars: 1 }] };
}

export function checkExpressionLimits(root: Expression): void {
  let count = 0;
  const visit = (node: Expression, depth: number, inWindow = false): void => {
    if (++count > 100 || depth > 8) throw new Error('Максимум 100 условий и 8 уровней вложенности');
    if (node.window && inWindow) throw new Error('Вложенные временные окна не поддерживаются; задайте окно группе или её отдельным условиям');
    if (node.kind === 'group') node.rules.forEach(child => visit(child, depth + 1, inWindow || Boolean(node.window)));
    else if (node.operator.startsWith('cross') &&
      node.right.kind === 'series' && node.left.timeframe !== node.right.timeframe) {
      throw new Error('Для пересечения выберите одинаковые таймфреймы обоих рядов');
    }
  };
  visit(root, 0);
}
export function signalExpressions(signal: Signal): Expression[] {
  return [signal.expression, ...(signal.temporal?.confirmations.map(c => c.expression) ?? []),
    ...(signal.temporal?.reset ? [signal.temporal.reset] : []), ...(signal.temporal?.completion ? [signal.temporal.completion] : []),
    ...(signal.temporal?.outcomes?.map(o => o.expression) ?? [])];
}
export function checkSignalLimits(signal: Signal): void {
  if (signal.temporal) {
    const ids = signal.temporal.confirmations.map(c => c.id);
    if (new Set(ids).size !== ids.length) throw new Error('Идентификаторы подтверждений должны быть уникальными');
    if (signal.temporal.mode === 'sequential' && signal.temporal.match !== 'all') throw new Error('Последовательная цепочка требует выполнения всех этапов');
    if (signal.temporal.outcomes?.length && (!signal.temporal.defaultOutcome || !signal.temporal.unknownOutcome)) throw new Error('Для меток задайте результат по умолчанию и результат при нехватке данных');
    if (new Set(signal.temporal.outcomes?.map(o => o.id)).size !== (signal.temporal.outcomes?.length ?? 0)) throw new Error('Идентификаторы итоговых меток должны быть уникальными');
  }
  let total = 0;
  const count = (node: Expression, triggerAvailable: boolean, pastMs = 0): void => {
    if (++total > 100) throw new Error('Максимум 100 узлов во всей схеме, включая триггер, подтверждения и сброс');
    if (node.window?.anchor === 'trigger' && !triggerAvailable) throw new Error('Окно от триггера доступно только в подтверждениях, итоговом фильтре и метках цепочки');
    if (node.window) pastMs += Math.max(0, -node.window.from) * intervalMs[node.window.timeframe];
    if (node.kind === 'group') node.rules.forEach(child => count(child, triggerAvailable, pastMs));
    else {
      for (const operand of [node.left, node.right]) if (operand.kind === 'series' &&
        Math.ceil((pastMs + (signal.temporal?.timeoutBars ?? 0) * intervalMs[signal.timeframe]) / intervalMs[operand.timeframe]) > 20000) {
        throw new Error('Окно цепочки требует более 20000 свечей одного из периодов. Уменьшите окно ожидания или разницу таймфреймов');
      }
    }
  };
  for (const expression of signalExpressions(signal)) {
    checkExpressionLimits(expression); count(expression, Boolean(signal.temporal) && expression !== signal.expression && expression !== signal.temporal?.reset);
  }
}
