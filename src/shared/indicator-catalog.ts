import type { SeriesField } from './model';

export interface IndicatorInfo {
  label: string;
  description: string;
  defaultPeriod: number;
  periodLabel?: string;
  requiresVolume?: boolean;
}

/** UI metadata for the same field identifiers that are stored in signal definitions. */
export const indicatorCatalog: Record<SeriesField, IndicatorInfo> = {
  legVolumeRatio: { label: 'Объём отскока / пролива', description: 'В последних N свечах: последний максимум High → последующий последний минимум Low → текущая свеча. Отношение средних объёмов на включительных участках; минимум входит в оба. Если минимум текущий, отскок — одна свеча. Нет последовательности, объёма или знаменатель 0 — «Нет данных».', defaultPeriod: 20, periodLabel: 'Окно поиска участков', requiresVolume: true },
  open: { label: 'Открытие', description: 'Цена открытия закрытой свечи.', defaultPeriod: 1 },
  high: { label: 'Максимум', description: 'Наибольшая цена закрытой свечи.', defaultPeriod: 1 },
  low: { label: 'Минимум', description: 'Наименьшая цена закрытой свечи.', defaultPeriod: 1 },
  close: { label: 'Закрытие', description: 'Цена закрытия свечи.', defaultPeriod: 1 },
  volume: { label: 'Объём', description: 'Объём, переданный поставщиком; отсутствие данных не заменяется нулём.', defaultPeriod: 1, requiresVolume: true },
  sma: { label: 'SMA', description: 'Простая средняя цен закрытия за N свечей.', defaultPeriod: 20, periodLabel: 'Период средней' },
  ema: { label: 'EMA', description: 'Экспоненциальная средняя цен закрытия, начальное значение — SMA.', defaultPeriod: 20, periodLabel: 'Период средней' },
  wma: { label: 'WMA', description: 'Взвешенная средняя цен закрытия; последняя свеча имеет наибольший вес.', defaultPeriod: 20, periodLabel: 'Период средней' },
  volumeSma: { label: 'Средний объём', description: 'Средний объём последних N закрытых свечей. В окно включена последняя свеча.', defaultPeriod: 9, periodLabel: 'Свечей в окне', requiresVolume: true },
  stochK: { label: 'Стохастик %K', description: 'Сглаженный %K; длина и сглаживание задаются параметрами стохастика.', defaultPeriod: 10 },
  stochD: { label: 'Стохастик %D', description: 'Сглаживание %K, параметры задаются отдельно.', defaultPeriod: 10 },
  macd: { label: 'MACD', description: 'Разность быстрой и медленной средних. Периоды и тип средних задаются отдельно.', defaultPeriod: 10 },
  macdSignal: { label: 'MACD signal', description: 'Сигнальная средняя MACD с выбранным периодом и типом.', defaultPeriod: 10 },
  macdHist: { label: 'MACD hist', description: 'MACD минус сигнальная средняя.', defaultPeriod: 10 },
  highest: { label: 'Локальный максимум', description: 'Максимум High последних N закрытых свечей, включая последнюю. Сдвиг 1 исключает последнюю свечу из окна.', defaultPeriod: 20, periodLabel: 'Свечей в окне' },
  lowest: { label: 'Локальный минимум', description: 'Минимум Low последних N закрытых свечей, включая последнюю. Сдвиг 1 исключает последнюю свечу из окна.', defaultPeriod: 20, periodLabel: 'Свечей в окне' },
  volumeSum: { label: 'Сумма объёма', description: 'Сумма объёмов последних N закрытых свечей. Если хотя бы один объём отсутствует, результат — «Нет данных».', defaultPeriod: 9, periodLabel: 'Свечей в окне', requiresVolume: true },
  fractalHigh: { label: 'Фрактал вверх', description: 'Последний максимум, подтверждённый за заданное окно (по умолчанию 100 свечей). High строго выше N свечей слева и справа; появляется после их закрытия. Равные вершины исключены. Отсчёт окна — от свечи подтверждения, включая её.', defaultPeriod: 2, periodLabel: 'Свечей с каждой стороны' },
  fractalLow: { label: 'Фрактал вниз', description: 'Последний минимум, подтверждённый за заданное окно (по умолчанию 100 свечей). Low строго ниже N свечей слева и справа; появляется после их закрытия. Равные впадины исключены. Отсчёт окна — от свечи подтверждения, включая её.', defaultPeriod: 2, periodLabel: 'Свечей с каждой стороны' },
};
