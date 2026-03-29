import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Image,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';

type Role = 'Производственный мастер' | 'Контролер' | 'Контрольный мастер' | 'Администратор';
type ShiftRole = 'Рабочий';
type BatchStatus = 'Готова к проверке' | 'Проверена' | 'Отправлено на сборку';
type DefectClass =
  | 'Без дефекта'
  | 'Царапина'
  | 'Трещина'
  | 'Коррозия'
  | 'Вмятина'
  | 'Раковина'
  | 'Неопределено';

type Batch = {
  id: string;
  productName: string;
  quantity: number;
  manufactureDate: string;
  workerName: string;
  status: BatchStatus;
};

type DefectItem = {
  id: string;
  defectClass: DefectClass;
  confidence: number;
  affectedCount: number;
  comment: string;
  imageUri?: string;
};

type Inspection = {
  id: string;
  batchId: string;
  inspector: string;
  date: string;
  visualConclusion: string;
  geometryConclusion: string;
  defects: DefectItem[];
  acceptedCount: number;
  rejectedCount: number;
  comment: string;
};

type User = {
  id: string;
  login: string;
  name: string;
  role: Role;
};

type Worker = {
  id: string;
  name: string;
};

type Shift = {
  id: string;
  date: string;
  employeeName: string;
  role: ShiftRole;
  batchId?: string;
  batchNumber?: string;
};

type RoboflowPrediction = {
  class?: string;
  confidence?: number;
};

type AiApiResponse = {
  defect?: string;
  confidence?: number;
  summary?: string;
  predictions?: RoboflowPrediction[];
};

type LoginResponse = {
  ok: boolean;
  token?: string;
  user?: {
    id: number | string;
    full_name: string;
    role: string;
    login?: string;
  };
  message?: string;
};

type ApiUserRow = {
  id: number | string;
  full_name: string;
  login: string;
  role: string;
};

type ApiWorkerRow = {
  id: number | string;
  full_name: string;
};

type ApiBatchRow = {
  id: number | string;
  batch_number: string;
  product_name: string;
  quantity: number;
  status: string;
  created_at?: string;
};

type ApiShiftRow = {
  id: number | string;
  worker_id: number | string;
  batch_id: number | string;
  shift_date: string;
  shift_type: string;
  full_name: string;
  batch_number: string;
};

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'https://defect-control.onrender.com';

const COLORS = {
  bg: '#0f172a',
  card: '#1e293b',
  soft: '#334155',
  accent: '#22c55e',
  accent2: '#38bdf8',
  text: '#e2e8f0',
  muted: '#94a3b8',
  border: '#334155',
};

const monthNames: Record<string, string> = {
  '01': 'Январь',
  '02': 'Февраль',
  '03': 'Март',
  '04': 'Апрель',
  '05': 'Май',
  '06': 'Июнь',
  '07': 'Июль',
  '08': 'Август',
  '09': 'Сентябрь',
  '10': 'Октябрь',
  '11': 'Ноябрь',
  '12': 'Декабрь',
};

function mapApiRoleToAppRole(role: string): Role {
  const roleMap: Record<string, Role> = {
    admin: 'Администратор',
    controller: 'Контролер',
    quality_master: 'Контрольный мастер',
    control_master: 'Контрольный мастер',
    production_master: 'Производственный мастер',
    'Администратор': 'Администратор',
    'Контролер': 'Контролер',
    'Контрольный мастер': 'Контрольный мастер',
    'Производственный мастер': 'Производственный мастер',
  };
  return roleMap[role] || 'Контролер';
}

function normalizeDefectLabel(label?: string): DefectClass {
  const value = (label || '').trim().toLowerCase().replace(/[-_]/g, ' ');
  if (!value) return 'Неопределено';
  if (
    value.includes('без дефекта') ||
    value.includes('дефект не обнаружен') ||
    value.includes('no defect') ||
    value.includes('normal') ||
    value.includes('ok') ||
    value.includes('not found')
  ) {
    return 'Без дефекта';
  }
  if (value.includes('царап') || value.includes('scratch')) return 'Царапина';
  if (value.includes('трещ') || value.includes('crack') || value.includes('crazing')) return 'Трещина';
  if (value.includes('корроз') || value.includes('pitted') || value.includes('scale')) return 'Коррозия';
  if (value.includes('вмят') || value.includes('dent') || value.includes('inclusion')) return 'Вмятина';
  if (value.includes('раков') || value.includes('patch')) return 'Раковина';
  return 'Неопределено';
}

function makeAiSummary(rawLabel: string | undefined, defect: DefectClass, confidence: number, count: number) {
  if (defect === 'Без дефекта' || count === 0) return 'Дефекты на изображении не обнаружены';
  const percent = (confidence * 100).toFixed(1);
  if (rawLabel && rawLabel !== defect) {
    return `Обнаружен дефект "${defect}" (${rawLabel}) с вероятностью ${percent}%`;
  }
  return `Обнаружен дефект "${defect}" с вероятностью ${percent}%`;
}

async function analyzeDefectViaApi(
  imageUri: string,
): Promise<{ defect: DefectClass; confidence: number; summary?: string }> {
  const formData = new FormData();
  formData.append(
    'file',
    {
      uri: imageUri,
      name: `defect_${Date.now()}.jpg`,
      type: 'image/jpeg',
    } as any,
  );

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(`${API_URL}/analyze-defect`, {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || `HTTP ${response.status}`);
    }

    const data = (await response.json()) as AiApiResponse;
    if (data.defect) {
      const defect = normalizeDefectLabel(data.defect);
      const confidence = Math.max(0, Math.min(1, Number(data.confidence ?? 0)));
      return {
        defect,
        confidence,
        summary: data.summary || makeAiSummary(data.defect, defect, confidence, 1),
      };
    }

    const predictions = Array.isArray(data.predictions) ? data.predictions : [];
    if (predictions.length === 0) {
      return {
        defect: 'Без дефекта',
        confidence: 0,
        summary: 'Дефекты на изображении не обнаружены',
      };
    }

    const bestPrediction = predictions.reduce((best, current) =>
      Number(current?.confidence ?? -1) > Number(best?.confidence ?? -1) ? current : best,
    );
    const bestRawLabel = bestPrediction?.class || 'unknown';
    const defect = normalizeDefectLabel(bestRawLabel);
    const confidence = Math.max(0, Math.min(1, Number(bestPrediction?.confidence ?? 0)));

    return {
      defect,
      confidence,
      summary: makeAiSummary(bestRawLabel, defect, confidence, predictions.length),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function todayStr() {
  return formatDate(new Date());
}

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function dateToMs(value?: string) {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function isDateInRange(value: string, from: string, to: string) {
  const current = dateToMs(value);
  if (from && current < dateToMs(from)) return false;
  if (to && current > dateToMs(to)) return false;
  return true;
}

function monthFolderName(date: string) {
  const [year, month] = date.split('-');
  return `${monthNames[month] || month} ${year}`;
}

function isCurrentMonth(date: string) {
  if (!date) return false;
  const now = new Date();
  const d = new Date(date);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

async function readJson(response: Response) {
  const rawText = await response.text();
  try {
    return rawText ? JSON.parse(rawText) : null;
  } catch {
    throw new Error(rawText || 'Некорректный ответ сервера');
  }
}

function Label({ text }: { text: string }) {
  return <Text style={styles.label}>{text}</Text>;
}

function SectionTitle({ title }: { title: string }) {
  return <Text style={styles.sectionTitle}>{title}</Text>;
}

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statTitle}>{title}</Text>
    </View>
  );
}

function StatusBadge({ status }: { status: BatchStatus }) {
  const backgroundColor =
    status === 'Готова к проверке' ? '#2563eb' : status === 'Проверена' ? '#15803d' : '#6b7280';

  return (
    <View style={[styles.badge, { backgroundColor }]}>
      <Text style={styles.badgeText}>{status}</Text>
    </View>
  );
}

function TabButton({
  title,
  active,
  onPress,
}: {
  title: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={[styles.tabButton, active && styles.tabButtonActive]} onPress={onPress}>
      <Text style={styles.tabButtonText}>{title}</Text>
    </Pressable>
  );
}

export default function App() {
  const [users, setUsers] = useState<User[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [appReady, setAppReady] = useState(false);

  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [, setToken] = useState('');
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [screen, setScreen] = useState<'dashboard' | 'batches' | 'inspection' | 'report' | 'schedule' | 'admin'>('dashboard');
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);

  const [newBatch, setNewBatch] = useState({
    productName: '',
    quantity: '1',
    manufactureDate: todayStr(),
    workerName: '',
  });

  const [newWorkerName, setNewWorkerName] = useState('');
  const [inspectionForm, setInspectionForm] = useState({
    visualConclusion: '',
    geometryConclusion: '',
    acceptedCount: '0',
    rejectedCount: '0',
    comment: '',
    imageUri: '',
  });
  const [detectedDefects, setDetectedDefects] = useState<DefectItem[]>([]);
  const [defectComment, setDefectComment] = useState('');
  const [inferenceState, setInferenceState] = useState<{
    loading: boolean;
    defect: DefectClass;
    confidence: number;
    summary?: string;
  }>({
    loading: false,
    defect: 'Неопределено',
    confidence: 0,
    summary: '',
  });

  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<CameraType>('back');
  const cameraRef = useRef<CameraView | null>(null);
  const [permission, requestPermission] = useCameraPermissions();

  const [shiftDate, setShiftDate] = useState(todayStr());
  const [shiftEmployeeName, setShiftEmployeeName] = useState('');
  const [shiftBatchId, setShiftBatchId] = useState('');

  const [reportDateFrom, setReportDateFrom] = useState('');
  const [reportDateTo, setReportDateTo] = useState('');

  const syncAllFromServer = async () => {
    const [usersRes, workersRes, batchesRes, shiftsRes] = await Promise.all([
      fetch(`${API_URL}/api/users`),
      fetch(`${API_URL}/api/workers`),
      fetch(`${API_URL}/api/batches`),
      fetch(`${API_URL}/api/shifts`),
    ]);

    const [usersData, workersData, batchesData, shiftsData] = await Promise.all([
      readJson(usersRes),
      readJson(workersRes),
      readJson(batchesRes),
      readJson(shiftsRes),
    ]);

    if (!usersRes.ok || !Array.isArray(usersData)) throw new Error('Не удалось получить пользователей');
    if (!workersRes.ok || !Array.isArray(workersData)) throw new Error('Не удалось получить рабочих');
    if (!batchesRes.ok || !Array.isArray(batchesData)) throw new Error('Не удалось получить партии');
    if (!shiftsRes.ok || !Array.isArray(shiftsData)) throw new Error('Не удалось получить смены');

    const nextUsers: User[] = (usersData as ApiUserRow[]).map((item) => ({
      id: String(item.id),
      login: item.login,
      name: item.full_name,
      role: mapApiRoleToAppRole(item.role),
    }));

    const nextWorkers: Worker[] = (workersData as ApiWorkerRow[]).map((item) => ({
      id: String(item.id),
      name: item.full_name,
    }));

    const nextShifts: Shift[] = (shiftsData as ApiShiftRow[]).map((item) => ({
      id: String(item.id),
      date: item.shift_date,
      employeeName: item.full_name,
      role: 'Рабочий',
      batchId: String(item.batch_id),
      batchNumber: item.batch_number,
    }));

    const nextBatches: Batch[] = (batchesData as ApiBatchRow[]).map((item) => {
      const batchWorkerNames = nextShifts
        .filter((shift) => shift.batchId === String(item.id))
        .map((shift) => shift.employeeName);

      return {
        id: String(item.id),
        productName: item.product_name,
        quantity: Number(item.quantity || 0),
        manufactureDate: (item.created_at || todayStr()).slice(0, 10),
        workerName: batchWorkerNames.join(', '),
        status: (item.status as BatchStatus) || 'Готова к проверке',
      };
    });

    setUsers(nextUsers);
    setWorkers(nextWorkers);
    setBatches(nextBatches);
    setShifts(nextShifts);
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await syncAllFromServer();
        if (mounted) setAppReady(true);
      } catch (error) {
        console.error(error);
        if (mounted) {
          Alert.alert('Ошибка', `Не удалось получить данные с сервера ${API_URL}`);
          setAppReady(true);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  const activeBatch = useMemo(
    () => batches.find((b) => b.id === selectedBatchId) || null,
    [batches, selectedBatchId],
  );

  const currentMonthBatches = useMemo(
    () => batches.filter((b) => isCurrentMonth(b.manufactureDate)),
    [batches],
  );

  const stats = useMemo(
    () => ({
      total: currentMonthBatches.length,
      readyCheck: currentMonthBatches.filter((b) => b.status === 'Готова к проверке').length,
      checked: currentMonthBatches.filter((b) => b.status === 'Проверена').length,
      sentToAssembly: currentMonthBatches.filter((b) => b.status === 'Отправлено на сборку').length,
    }),
    [currentMonthBatches],
  );

  const batchInspections = useMemo(
    () => (selectedBatchId ? inspections.filter((i) => i.batchId === selectedBatchId) : []),
    [inspections, selectedBatchId],
  );

  const visibleBatchesPage = useMemo(
    () =>
      [...batches]
        .filter((b) => b.status === 'Готова к проверке' || b.status === 'Проверена')
        .sort((a, b) =>
          a.status === b.status
            ? dateToMs(b.manufactureDate) - dateToMs(a.manufactureDate)
            : a.status === 'Готова к проверке'
              ? -1
              : 1,
        ),
    [batches],
  );

  const reportBatches = useMemo(
    () =>
      batches
        .filter((b) => b.status === 'Отправлено на сборку')
        .filter((b) => isDateInRange(b.manufactureDate, reportDateFrom, reportDateTo))
        .sort((a, b) => dateToMs(b.manufactureDate) - dateToMs(a.manufactureDate)),
    [batches, reportDateFrom, reportDateTo],
  );

  const recentArchive = useMemo(() => {
    const monthAgoMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return reportBatches.filter((b) => dateToMs(b.manufactureDate) >= monthAgoMs);
  }, [reportBatches]);

  const folderedArchive = useMemo(() => {
    const monthAgoMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const older = reportBatches.filter((b) => dateToMs(b.manufactureDate) < monthAgoMs);
    const grouped: Record<string, Batch[]> = {};
    older.forEach((b) => {
      const folder = monthFolderName(b.manufactureDate);
      if (!grouped[folder]) grouped[folder] = [];
      grouped[folder].push(b);
    });
    return grouped;
  }, [reportBatches]);

  const visibleShifts = useMemo(
    () =>
      shifts
        .filter((s) => !shiftDate || s.date === shiftDate)
        .sort((a, b) => `${a.date}-${a.employeeName}`.localeCompare(`${b.date}-${b.employeeName}`)),
    [shifts, shiftDate],
  );

  const handleLogin = async () => {
    try {
      const response = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: login.trim(), password }),
      });

      const data = (await readJson(response)) as LoginResponse;
      if (!response.ok || !data.user || !data.token) {
        Alert.alert('Ошибка', data?.message || 'Неверный логин или пароль');
        return;
      }

      setToken(data.token);
      setCurrentUser({
        id: String(data.user.id),
        login: data.user.login || login.trim(),
        name: data.user.full_name,
        role: mapApiRoleToAppRole(data.user.role),
      });
      setScreen('dashboard');
      await syncAllFromServer();
    } catch {
      Alert.alert('Ошибка', `Не удалось подключиться к серверу ${API_URL}`);
    }
  };

  const handleLogout = () => {
    setCurrentUser(null);
    setSelectedBatchId(null);
    setToken('');
    setLogin('');
    setPassword('');
    setCameraOpen(false);
  };

  const createBatch = async () => {
    if (!currentUser) return;
    if (!newBatch.productName.trim() || !newBatch.workerName.trim()) {
      Alert.alert('Ошибка', 'Заполните наименование изделия и выберите работника');
      return;
    }

    const worker = workers.find((w) => w.name === newBatch.workerName.trim());
    if (!worker) {
      Alert.alert('Ошибка', 'Рабочий не найден на сервере');
      return;
    }

    try {
      const batchResponse = await fetch(`${API_URL}/api/batches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batch_number: `P-${String(Date.now()).slice(-6)}`,
          product_name: newBatch.productName.trim(),
          quantity: Number(newBatch.quantity || '0'),
          created_by: Number(currentUser.id),
        }),
      });
      const batchData = await readJson(batchResponse);
      if (!batchResponse.ok || !batchData?.id) {
        Alert.alert('Ошибка', batchData?.message || 'Не удалось создать партию');
        return;
      }

      const shiftResponse = await fetch(`${API_URL}/api/shifts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          worker_id: Number(worker.id),
          batch_id: Number(batchData.id),
          shift_date: newBatch.manufactureDate,
          shift_type: 'day',
          assigned_by: Number(currentUser.id),
        }),
      });
      const shiftData = await readJson(shiftResponse);
      if (!shiftResponse.ok) {
        Alert.alert('Ошибка', shiftData?.message || 'Партия создана, но смена не назначена');
      }

      await syncAllFromServer();
      setNewBatch({
        productName: '',
        quantity: '1',
        manufactureDate: todayStr(),
        workerName: '',
      });
      Alert.alert('Готово', 'Партия создана и сохранена на сервере');
    } catch {
      Alert.alert('Ошибка', 'Не удалось создать партию');
    }
  };

  const openCamera = async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        Alert.alert('Нет доступа', 'Нужно разрешение на использование камеры');
        return;
      }
    }
    setCameraOpen(true);
  };

  const pickImageFromGallery = async () => {
    const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permissionResult.granted) {
      Alert.alert('Нет доступа', 'Разрешите доступ к галерее');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
      allowsEditing: false,
    });
    if (!result.canceled && result.assets?.length) {
      setInspectionForm((prev) => ({ ...prev, imageUri: result.assets[0].uri }));
    }
  };

  const capturePhoto = async () => {
    const photo = await cameraRef.current?.takePictureAsync({ quality: 0.7 });
    if (!photo?.uri) {
      Alert.alert('Ошибка', 'Не удалось сделать снимок');
      return;
    }
    setInspectionForm((prev) => ({ ...prev, imageUri: photo.uri }));
    setCameraOpen(false);
  };

  const resetCapturedPhoto = () => {
    setInspectionForm((prev) => ({ ...prev, imageUri: '' }));
  };

  const performInference = async () => {
    if (!inspectionForm.imageUri) {
      Alert.alert('Нет снимка', 'Сначала сделайте снимок дефекта');
      return;
    }
    try {
      setInferenceState({ loading: true, defect: 'Неопределено', confidence: 0, summary: '' });
      const result = await analyzeDefectViaApi(inspectionForm.imageUri);
      setInferenceState({
        loading: false,
        defect: result.defect,
        confidence: result.confidence,
        summary: result.summary || '',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось получить ответ от AI API';
      setInferenceState({ loading: false, defect: 'Неопределено', confidence: 0, summary: '' });
      Alert.alert('Ошибка AI-анализа', `${message}\n\nПроверьте API_URL и доступность backend-сервера.`);
    }
  };

  const addDetectedDefect = () => {
    if (inferenceState.defect === 'Неопределено') {
      Alert.alert('Ошибка', 'Сначала выполните AI-анализ');
      return;
    }
    const affectedCount = Number(inspectionForm.rejectedCount || '0');
    if (affectedCount <= 0) {
      Alert.alert('Ошибка', 'Укажите количество бракованных изделий');
      return;
    }

    setDetectedDefects((prev) => [
      {
        id: uid('D'),
        defectClass: inferenceState.defect,
        confidence: inferenceState.confidence,
        affectedCount,
        comment: defectComment.trim(),
        imageUri: inspectionForm.imageUri || undefined,
      },
      ...prev,
    ]);
    setDefectComment('');
    setInspectionForm((prev) => ({ ...prev, imageUri: '', rejectedCount: '0' }));
    setInferenceState({ loading: false, defect: 'Неопределено', confidence: 0, summary: '' });
  };

  const removeDetectedDefect = (defectId: string) => {
    setDetectedDefects((prev) => prev.filter((item) => item.id !== defectId));
  };

  const saveInspection = async () => {
    if (!currentUser || !activeBatch) return;
    const acceptedCount = Number(inspectionForm.acceptedCount || '0');
    const rejectedTotal = detectedDefects.reduce((sum, item) => sum + item.affectedCount, 0);

    setInspections((prev) => [
      {
        id: uid('I'),
        batchId: activeBatch.id,
        inspector: currentUser.name,
        date: todayStr(),
        visualConclusion: inspectionForm.visualConclusion.trim(),
        geometryConclusion: inspectionForm.geometryConclusion.trim(),
        defects: detectedDefects,
        acceptedCount,
        rejectedCount: rejectedTotal,
        comment: inspectionForm.comment.trim(),
      },
      ...prev,
    ]);

    setBatches((prev) => prev.map((b) => (b.id === activeBatch.id ? { ...b, status: 'Проверена' } : b)));
    setInspectionForm({
      visualConclusion: '',
      geometryConclusion: '',
      acceptedCount: '0',
      rejectedCount: '0',
      comment: '',
      imageUri: '',
    });
    setDetectedDefects([]);
    setDefectComment('');
    setInferenceState({ loading: false, defect: 'Неопределено', confidence: 0, summary: '' });

    Alert.alert(
      'Готово',
      'Контроль сохранён локально в приложении. Серверные маршруты для отчётов добавим следующим шагом.',
    );
  };

  const addWorker = async () => {
    const name = newWorkerName.trim();
    if (!name) {
      Alert.alert('Ошибка', 'Введите имя рабочего');
      return;
    }
    if (workers.some((w) => w.name.toLowerCase() === name.toLowerCase())) {
      Alert.alert('Ошибка', 'Такой рабочий уже существует');
      return;
    }

    const response = await fetch(`${API_URL}/api/workers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full_name: name }),
    });
    const data = await readJson(response);
    if (!response.ok) {
      Alert.alert('Ошибка', data?.message || 'Не удалось добавить рабочего');
      return;
    }

    await syncAllFromServer();
    setNewWorkerName('');
    Alert.alert('Готово', 'Рабочий добавлен');
  };

  const addShift = async () => {
    if (!currentUser) return;
    if (!shiftDate || !shiftEmployeeName.trim() || !shiftBatchId) {
      Alert.alert('Ошибка', 'Укажите дату, рабочего и партию');
      return;
    }

    const worker = workers.find((w) => w.name === shiftEmployeeName.trim());
    if (!worker) {
      Alert.alert('Ошибка', 'Рабочий не найден');
      return;
    }

    const response = await fetch(`${API_URL}/api/shifts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        worker_id: Number(worker.id),
        batch_id: Number(shiftBatchId),
        shift_date: shiftDate,
        shift_type: 'day',
        assigned_by: Number(currentUser.id),
      }),
    });
    const data = await readJson(response);
    if (!response.ok) {
      Alert.alert('Ошибка', data?.message || 'Не удалось назначить смену');
      return;
    }

    await syncAllFromServer();
    Alert.alert('Готово', 'Смена назначена');
  };

  const renderBatchCard = (batch: Batch) => {
    const lastInspection = inspections.find((i) => i.batchId === batch.id);

    return (
      <View key={batch.id} style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.cardTitle}>{batch.productName}</Text>
          <StatusBadge status={batch.status} />
        </View>
        <Text style={styles.text}>ID партии: {batch.id}</Text>
        <Text style={styles.text}>Количество: {batch.quantity}</Text>
        <Text style={styles.text}>Дата: {batch.manufactureDate}</Text>
        <Text style={styles.text}>Работник: {batch.workerName || 'Не назначен'}</Text>

        {lastInspection && (
          <View style={styles.cardSoft}>
            <Text style={styles.cardSubTitle}>Последний отчёт</Text>
            <Text style={styles.text}>Дата контроля: {lastInspection.date}</Text>
            <Text style={styles.text}>Проверил: {lastInspection.inspector}</Text>
            <Text style={styles.text}>Годных: {lastInspection.acceptedCount}</Text>
            <Text style={styles.text}>Бракованных: {lastInspection.rejectedCount}</Text>
          </View>
        )}
      </View>
    );
  };

  if (cameraOpen) {
    return (
      <SafeAreaView style={styles.cameraScreen}>
        <CameraView ref={cameraRef} facing={cameraFacing} style={styles.cameraPreview}>
          <View style={styles.cameraOverlay}>
            <Text style={styles.cameraTitle}>Сделайте снимок дефекта</Text>
            <View style={styles.cameraActions}>
              <Pressable
                style={styles.secondaryButton}
                onPress={() => setCameraFacing((prev) => (prev === 'back' ? 'front' : 'back'))}
              >
                <Text style={styles.secondaryButtonText}>Сменить камеру</Text>
              </Pressable>
              <Pressable style={styles.captureButton} onPress={capturePhoto}>
                <Text style={styles.captureButtonText}>Снять</Text>
              </Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => setCameraOpen(false)}>
                <Text style={styles.secondaryButtonText}>Закрыть</Text>
              </Pressable>
            </View>
          </View>
        </CameraView>
      </SafeAreaView>
    );
  }

  const showInspectionTab =
    currentUser?.role === 'Контролер' ||
    currentUser?.role === 'Контрольный мастер' ||
    currentUser?.role === 'Администратор';

  const showScheduleTab =
    currentUser?.role === 'Производственный мастер' || currentUser?.role === 'Администратор';

  if (!appReady) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={[styles.container, { justifyContent: 'center', flex: 1 }]}>
          <View style={styles.phone}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Загрузка данных...</Text>
              <Text style={styles.text}>Подключение к серверу.</Text>
            </View>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (!currentUser) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.container}>
          <View style={styles.phone}>
            <View style={styles.headerBlock}>
              <Text style={styles.title}>ИЦМ</Text>
            </View>
            <View style={styles.card}>
              <Label text="Логин" />
              <TextInput style={styles.input} value={login} onChangeText={setLogin} />
              <Label text="Пароль" />
              <TextInput style={styles.input} secureTextEntry value={password} onChangeText={setPassword} />
              <Pressable style={styles.primaryButton} onPress={handleLogin}>
                <Text style={styles.primaryButtonText}>Войти</Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.phone}>
          <View style={styles.topBar}>
            <View>
              <Text style={styles.topRole}>{currentUser.role}</Text>
              <Text style={styles.topName}>{currentUser.name}</Text>
            </View>
            <Pressable style={styles.secondaryButton} onPress={handleLogout}>
              <Text style={styles.secondaryButtonText}>Выход</Text>
            </Pressable>
          </View>

          <View style={styles.navRow}>
            <TabButton title="Главная" active={screen === 'dashboard'} onPress={() => setScreen('dashboard')} />
            <TabButton title="Партии" active={screen === 'batches'} onPress={() => setScreen('batches')} />
            {showInspectionTab && (
              <TabButton title="Контроль" active={screen === 'inspection'} onPress={() => setScreen('inspection')} />
            )}
            <TabButton title="Отчёты" active={screen === 'report'} onPress={() => setScreen('report')} />
            {showScheduleTab && (
              <TabButton title="Смены" active={screen === 'schedule'} onPress={() => setScreen('schedule')} />
            )}
            {currentUser.role === 'Администратор' && (
              <TabButton title="Админ" active={screen === 'admin'} onPress={() => setScreen('admin')} />
            )}
          </View>

          {screen === 'dashboard' && (
            <View>
              <SectionTitle title="Сводка производства" />
              <View style={styles.grid2}>
                <StatCard title="Партий за месяц" value={String(stats.total)} />
                <StatCard title="Готовы к проверке" value={String(stats.readyCheck)} />
                <StatCard title="Проверены" value={String(stats.checked)} />
                <StatCard title="Отправлены на сборку" value={String(stats.sentToAssembly)} />
              </View>
            </View>
          )}

          {screen === 'batches' && (
            <View>
              <SectionTitle title="Партии" />
              {(currentUser.role === 'Производственный мастер' || currentUser.role === 'Администратор') && (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Создание партии</Text>
                  <Label text="Наименование изделия" />
                  <TextInput
                    style={styles.input}
                    value={newBatch.productName}
                    onChangeText={(value) => setNewBatch((prev) => ({ ...prev, productName: value }))}
                  />
                  <Label text="Количество" />
                  <TextInput
                    style={styles.input}
                    keyboardType="numeric"
                    value={newBatch.quantity}
                    onChangeText={(value) => setNewBatch((prev) => ({ ...prev, quantity: value }))}
                  />
                  <Label text="Дата изготовления" />
                  <TextInput
                    style={styles.input}
                    value={newBatch.manufactureDate}
                    onChangeText={(value) => setNewBatch((prev) => ({ ...prev, manufactureDate: value }))}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={COLORS.muted}
                  />
                  <Label text="Рабочий" />
                  <View style={styles.roleRow}>
                    {workers.length === 0 ? (
                      <Text style={styles.text}>Рабочих пока нет.</Text>
                    ) : (
                      workers.map((worker) => (
                        <Pressable
                          key={worker.id}
                          style={[styles.roleButton, newBatch.workerName === worker.name && styles.roleButtonActive]}
                          onPress={() => setNewBatch((prev) => ({ ...prev, workerName: worker.name }))}
                        >
                          <Text
                            style={[styles.roleButtonText, newBatch.workerName === worker.name && styles.roleButtonTextActive]}
                          >
                            {worker.name}
                          </Text>
                        </Pressable>
                      ))
                    )}
                  </View>
                  <Pressable style={styles.primaryButton} onPress={createBatch}>
                    <Text style={styles.primaryButtonText}>Создать партию</Text>
                  </Pressable>
                </View>
              )}

              {visibleBatchesPage.length === 0 ? (
                <View style={styles.card}>
                  <Text style={styles.text}>Нет партий для отображения.</Text>
                </View>
              ) : (
                visibleBatchesPage.map((batch) => renderBatchCard(batch))
              )}
            </View>
          )}

          {screen === 'inspection' && (
            <View>
              <SectionTitle title="Контроль" />
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Выберите партию для контроля</Text>
                <View style={styles.roleRow}>
                  {batches
                    .filter((b) => b.status === 'Готова к проверке' || b.id === selectedBatchId)
                    .map((batch) => (
                      <Pressable
                        key={batch.id}
                        style={[styles.roleButton, selectedBatchId === batch.id && styles.roleButtonActive]}
                        onPress={() => setSelectedBatchId(batch.id)}
                      >
                        <Text
                          style={[styles.roleButtonText, selectedBatchId === batch.id && styles.roleButtonTextActive]}
                        >
                          {batch.productName} #{batch.id}
                        </Text>
                      </Pressable>
                    ))}
                </View>
              </View>

              {!activeBatch ? (
                <View style={styles.card}>
                  <Text style={styles.text}>Сначала выберите партию.</Text>
                </View>
              ) : (
                <>
                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>{activeBatch.productName}</Text>
                    <Text style={styles.text}>Партия: {activeBatch.id}</Text>
                    <Text style={styles.text}>Количество: {activeBatch.quantity}</Text>
                    <Text style={styles.text}>Работник: {activeBatch.workerName || 'Не назначен'}</Text>
                  </View>

                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>Результаты контроля</Text>
                    <Label text="Изображение для анализа" />
                    {!inspectionForm.imageUri && (
                      <>
                        <Pressable style={styles.primaryButton} onPress={openCamera}>
                          <Text style={styles.primaryButtonText}>Открыть камеру</Text>
                        </Pressable>
                        <Pressable style={styles.secondaryButton} onPress={pickImageFromGallery}>
                          <Text style={styles.secondaryButtonText}>Выбрать из галереи</Text>
                        </Pressable>
                      </>
                    )}

                    {!!inspectionForm.imageUri && (
                      <View style={styles.previewBox}>
                        <Image source={{ uri: inspectionForm.imageUri }} style={styles.imagePreview} />
                        <View style={styles.actionsWrap}>
                          <Pressable style={styles.secondaryButton} onPress={resetCapturedPhoto}>
                            <Text style={styles.secondaryButtonText}>Удалить снимок</Text>
                          </Pressable>
                          <Pressable style={styles.secondaryButton} onPress={openCamera}>
                            <Text style={styles.secondaryButtonText}>Переснять</Text>
                          </Pressable>
                        </View>
                      </View>
                    )}

                    <Pressable style={styles.primaryButton} onPress={performInference}>
                      <Text style={styles.primaryButtonText}>
                        {inferenceState.loading ? 'Анализ...' : 'Запустить AI-анализ'}
                      </Text>
                    </Pressable>

                    <View style={styles.aiBox}>
                      <Text style={styles.text}>
                        Класс дефекта: <Text style={styles.textBold}>{inferenceState.defect}</Text>
                      </Text>
                      <Text style={styles.text}>
                        Уверенность: <Text style={styles.textBold}>{(inferenceState.confidence * 100).toFixed(1)}%</Text>
                      </Text>
                      {!!inferenceState.summary && (
                        <Text style={[styles.text, { marginTop: 8 }]}>
                          Комментарий AI: <Text style={styles.textBold}>{inferenceState.summary}</Text>
                        </Text>
                      )}
                    </View>

                    <Label text="Комментарий к найденному дефекту" />
                    <TextInput style={styles.textarea} multiline value={defectComment} onChangeText={setDefectComment} />
                    <Label text="Количество изделий с этим дефектом" />
                    <TextInput
                      style={styles.input}
                      keyboardType="numeric"
                      value={inspectionForm.rejectedCount}
                      onChangeText={(value) => setInspectionForm((prev) => ({ ...prev, rejectedCount: value }))}
                    />
                    <Pressable style={styles.primaryButton} onPress={addDetectedDefect}>
                      <Text style={styles.primaryButtonText}>Добавить дефект в список</Text>
                    </Pressable>

                    <View style={styles.cardSoft}>
                      <Text style={styles.cardSubTitle}>Список дефектов по партии</Text>
                      {detectedDefects.length === 0 ? (
                        <Text style={styles.text}>Пока не добавлено ни одного дефекта.</Text>
                      ) : (
                        detectedDefects.map((item, index) => (
                          <View key={item.id} style={styles.historyItem}>
                            <Text style={styles.text}>
                              <Text style={styles.textBold}>Дефект {index + 1}:</Text> {item.defectClass}
                            </Text>
                            <Text style={styles.text}>Уверенность: {(item.confidence * 100).toFixed(1)}%</Text>
                            <Text style={styles.text}>Количество изделий с этим дефектом: {item.affectedCount}</Text>
                            <Text style={styles.text}>Комментарий: {item.comment || '—'}</Text>
                            {!!item.imageUri && <Image source={{ uri: item.imageUri }} style={styles.imagePreviewSmall} />}
                            <Pressable style={styles.secondaryButton} onPress={() => removeDetectedDefect(item.id)}>
                              <Text style={styles.secondaryButtonText}>Удалить дефект</Text>
                            </Pressable>
                          </View>
                        ))
                      )}
                    </View>

                    <Label text="Заключение визуального контроля" />
                    <TextInput
                      style={styles.textarea}
                      multiline
                      value={inspectionForm.visualConclusion}
                      onChangeText={(value) => setInspectionForm((prev) => ({ ...prev, visualConclusion: value }))}
                    />
                    <Label text="Заключение по конструктивным параметрам" />
                    <TextInput
                      style={styles.textarea}
                      multiline
                      value={inspectionForm.geometryConclusion}
                      onChangeText={(value) => setInspectionForm((prev) => ({ ...prev, geometryConclusion: value }))}
                    />
                    <Label text="Годных изделий" />
                    <TextInput
                      style={styles.input}
                      keyboardType="numeric"
                      value={inspectionForm.acceptedCount}
                      onChangeText={(value) => setInspectionForm((prev) => ({ ...prev, acceptedCount: value }))}
                    />
                    <Label text="Общий комментарий по партии" />
                    <TextInput
                      style={styles.textarea}
                      multiline
                      value={inspectionForm.comment}
                      onChangeText={(value) => setInspectionForm((prev) => ({ ...prev, comment: value }))}
                    />
                    <Pressable style={styles.primaryButton} onPress={saveInspection}>
                      <Text style={styles.primaryButtonText}>Сохранить контроль</Text>
                    </Pressable>
                  </View>

                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>История проверок</Text>
                    {batchInspections.length === 0 ? (
                      <Text style={styles.text}>Пока нет сохранённых проверок.</Text>
                    ) : (
                      batchInspections.map((item) => (
                        <View key={item.id} style={styles.historyItem}>
                          <Text style={styles.text}><Text style={styles.textBold}>Дата:</Text> {item.date}</Text>
                          <Text style={styles.text}><Text style={styles.textBold}>Контролёр:</Text> {item.inspector}</Text>
                          <Text style={styles.text}><Text style={styles.textBold}>Визуально:</Text> {item.visualConclusion}</Text>
                          <Text style={styles.text}><Text style={styles.textBold}>Геометрия:</Text> {item.geometryConclusion}</Text>
                          <Text style={styles.text}><Text style={styles.textBold}>Годных:</Text> {item.acceptedCount}</Text>
                          <Text style={styles.text}><Text style={styles.textBold}>Брак:</Text> {item.rejectedCount}</Text>
                        </View>
                      ))
                    )}
                  </View>
                </>
              )}
            </View>
          )}

          {screen === 'report' && (
            <View>
              <SectionTitle title="Отчёты" />
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Фильтр по датам</Text>
                <Label text="Дата от" />
                <TextInput
                  style={styles.input}
                  value={reportDateFrom}
                  onChangeText={setReportDateFrom}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={COLORS.muted}
                />
                <Label text="Дата до" />
                <TextInput
                  style={styles.input}
                  value={reportDateTo}
                  onChangeText={setReportDateTo}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={COLORS.muted}
                />
                <Pressable
                  style={styles.secondaryButton}
                  onPress={() => {
                    setReportDateFrom('');
                    setReportDateTo('');
                  }}
                >
                  <Text style={styles.secondaryButtonText}>Сбросить фильтр</Text>
                </Pressable>
              </View>

              <View style={styles.card}>
                <Text style={styles.cardTitle}>Отчёты за последний месяц</Text>
                {recentArchive.length === 0 ? (
                  <Text style={styles.text}>Нет отчётов за последний месяц.</Text>
                ) : (
                  recentArchive.map((batch) => renderBatchCard(batch))
                )}
              </View>

              <View style={styles.card}>
                <Text style={styles.cardTitle}>Архив по месяцам</Text>
                {Object.keys(folderedArchive).length === 0 ? (
                  <Text style={styles.text}>Архивных отчётов старше месяца нет.</Text>
                ) : (
                  Object.entries(folderedArchive).map(([folder, items]) => (
                    <View key={folder} style={styles.cardSoft}>
                      <Text style={styles.cardSubTitle}>{folder}</Text>
                      {items.map((batch) => renderBatchCard(batch))}
                    </View>
                  ))
                )}
              </View>
            </View>
          )}

          {screen === 'schedule' && showScheduleTab && (
            <View>
              <SectionTitle title="Смены" />
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Назначить смену</Text>
                <Label text="Дата" />
                <TextInput
                  style={styles.input}
                  value={shiftDate}
                  onChangeText={setShiftDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={COLORS.muted}
                />
                <Label text="Рабочий" />
                <View style={styles.roleRow}>
                  {workers.map((worker) => (
                    <Pressable
                      key={worker.id}
                      style={[styles.roleButton, shiftEmployeeName === worker.name && styles.roleButtonActive]}
                      onPress={() => setShiftEmployeeName(worker.name)}
                    >
                      <Text
                        style={[styles.roleButtonText, shiftEmployeeName === worker.name && styles.roleButtonTextActive]}
                      >
                        {worker.name}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Label text="Партия" />
                <View style={styles.roleRow}>
                  {batches.map((batch) => (
                    <Pressable
                      key={batch.id}
                      style={[styles.roleButton, shiftBatchId === batch.id && styles.roleButtonActive]}
                      onPress={() => setShiftBatchId(batch.id)}
                    >
                      <Text
                        style={[styles.roleButtonText, shiftBatchId === batch.id && styles.roleButtonTextActive]}
                      >
                        {batch.productName} #{batch.id}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Pressable style={styles.primaryButton} onPress={addShift}>
                  <Text style={styles.primaryButtonText}>Назначить смену</Text>
                </Pressable>
              </View>

              <View style={styles.card}>
                <Text style={styles.cardTitle}>Список смен</Text>
                {visibleShifts.length === 0 ? (
                  <Text style={styles.text}>На выбранную дату смен нет.</Text>
                ) : (
                  visibleShifts.map((shift) => (
                    <View key={shift.id} style={styles.historyItem}>
                      <Text style={styles.text}><Text style={styles.textBold}>{shift.date}</Text></Text>
                      <Text style={styles.text}>Сотрудник: {shift.employeeName}</Text>
                      <Text style={styles.text}>Партия: {shift.batchNumber || shift.batchId}</Text>
                      <Text style={styles.text}>Роль: {shift.role}</Text>
                    </View>
                  ))
                )}
              </View>
            </View>
          )}

          {screen === 'admin' && currentUser.role === 'Администратор' && (
            <View>
              <SectionTitle title="Панель администратора" />
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Пользователи</Text>
                {users.map((u) => (
                  <View key={u.id} style={styles.historyItem}>
                    <Text style={styles.text}><Text style={styles.textBold}>{u.name}</Text></Text>
                    <Text style={styles.text}>Логин: {u.login}</Text>
                    <Text style={styles.text}>Роль: {u.role}</Text>
                  </View>
                ))}
              </View>

              <View style={styles.card}>
                <Text style={styles.cardTitle}>Рабочие</Text>
                <Label text="Новый рабочий" />
                <TextInput style={styles.input} value={newWorkerName} onChangeText={setNewWorkerName} />
                <Pressable style={styles.primaryButton} onPress={addWorker}>
                  <Text style={styles.primaryButtonText}>Добавить рабочего</Text>
                </Pressable>
                {workers.map((worker) => (
                  <View key={worker.id} style={styles.historyItem}>
                    <Text style={styles.text}>{worker.name}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#020617' },
  container: { padding: 16, alignItems: 'center' },
  phone: {
    width: '100%',
    maxWidth: 520,
    backgroundColor: COLORS.bg,
    borderRadius: 24,
    padding: 16,
    minHeight: '100%',
  },
  headerBlock: { marginBottom: 18 },
  title: { color: COLORS.text, fontSize: 30, fontWeight: '800' },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  topRole: {
    color: COLORS.accent2,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  topName: { color: COLORS.text, fontSize: 20, fontWeight: '700', marginTop: 2 },
  navRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 16, marginBottom: 18 },
  tabButton: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginRight: 8,
    marginBottom: 8,
  },
  tabButtonActive: { backgroundColor: '#1d4ed8' },
  tabButtonText: { color: COLORS.text, fontWeight: '600' },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 18,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cardSoft: {
    backgroundColor: '#162033',
    borderRadius: 14,
    padding: 12,
    marginTop: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cardTitle: { color: COLORS.text, fontSize: 18, fontWeight: '700', marginBottom: 10 },
  cardSubTitle: { color: COLORS.text, fontSize: 16, fontWeight: '700', marginBottom: 8 },
  text: { color: COLORS.text, fontSize: 14, lineHeight: 20, marginVertical: 2 },
  textBold: { fontWeight: '700' },
  label: { color: COLORS.muted, fontSize: 13, marginTop: 8, marginBottom: 6 },
  input: {
    width: '100%',
    backgroundColor: '#0b1220',
    color: COLORS.text,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
  },
  textarea: {
    width: '100%',
    minHeight: 88,
    backgroundColor: '#0b1220',
    color: COLORS.text,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
    textAlignVertical: 'top',
  },
  primaryButton: {
    width: '100%',
    backgroundColor: COLORS.accent,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginTop: 8,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#052e16', fontWeight: '800' },
  secondaryButton: {
    backgroundColor: COLORS.soft,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
    marginRight: 8,
    marginBottom: 8,
  },
  secondaryButtonText: { color: COLORS.text, fontWeight: '700' },
  sectionTitle: { color: COLORS.text, fontSize: 22, fontWeight: '700', marginBottom: 12 },
  grid2: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 14 },
  statCard: {
    width: '48%',
    backgroundColor: COLORS.card,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginRight: '2%',
    marginBottom: 10,
  },
  statValue: { fontSize: 28, fontWeight: '800', color: COLORS.accent2 },
  statTitle: { marginTop: 6, color: COLORS.muted, fontSize: 13 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  badge: { borderRadius: 999, paddingVertical: 6, paddingHorizontal: 10, marginLeft: 8 },
  badgeText: { color: 'white', fontSize: 12, fontWeight: '700' },
  actionsWrap: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 12 },
  aiBox: {
    backgroundColor: '#082f49',
    borderWidth: 1,
    borderColor: '#0ea5e9',
    borderRadius: 14,
    padding: 12,
    marginTop: 12,
    marginBottom: 12,
  },
  historyItem: { borderTopWidth: 1, borderTopColor: COLORS.border, paddingTop: 10, marginTop: 10 },
  previewBox: {
    backgroundColor: '#0b1220',
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 12,
    marginBottom: 12,
  },
  imagePreview: { width: '100%', height: 260, borderRadius: 12, marginBottom: 12, backgroundColor: '#000' },
  imagePreviewSmall: {
    width: '100%',
    height: 180,
    borderRadius: 10,
    marginTop: 8,
    marginBottom: 8,
    backgroundColor: '#000',
  },
  roleRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8, marginTop: 4 },
  roleButton: {
    backgroundColor: '#0b1220',
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginRight: 8,
    marginBottom: 8,
  },
  roleButtonActive: { backgroundColor: COLORS.accent2, borderColor: COLORS.accent2 },
  roleButtonText: { color: COLORS.text, fontWeight: '600' },
  roleButtonTextActive: { color: '#082f49', fontWeight: '800' },
  cameraScreen: { flex: 1, backgroundColor: 'black' },
  cameraPreview: { flex: 1 },
  cameraOverlay: {
    flex: 1,
    justifyContent: 'space-between',
    padding: 20,
    backgroundColor: 'rgba(0,0,0,0.15)',
  },
  cameraTitle: { color: 'white', fontSize: 20, fontWeight: '700', marginTop: 20 },
  cameraActions: { marginBottom: 24 },
  captureButton: {
    backgroundColor: 'white',
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  captureButtonText: { color: '#111827', fontWeight: '800', fontSize: 16 },
});
