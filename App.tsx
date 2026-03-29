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
import * as SQLite from 'expo-sqlite';

type Role = 'Производственный мастер' | 'Контролер' | 'Контрольный мастер' | 'Администратор';
type ShiftRole = 'Рабочий' | 'Контролер' | 'Производственный мастер' | 'Контрольный мастер';

type BatchStatus =
  | 'Готова к проверке'
  | 'Проверена'
  | 'Отправлено на сборку';

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
  shipmentNumber?: string;
  shipmentDate?: string;
  assignedToController?: string;
  assignedToControllerId?: string;
  inspectionAcceptedAt?: string;
  assemblySentAt?: string;
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
  password: string;
  name: string;
  role: Role;
};

type Shift = {
  id: string;
  date: string;
  employeeName: string;
  role: ShiftRole;
};

type Worker = {
  id: string;
  name: string;
};

const COLORS = {
  bg: '#0f172a',
  card: '#1e293b',
  soft: '#334155',
  accent: '#22c55e',
  accent2: '#38bdf8',
  text: '#e2e8f0',
  muted: '#94a3b8',
  danger: '#ef4444',
  warn: '#f59e0b',
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

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'https://defect-ai-backend.onrender.com';

type RoboflowPrediction = {
  class?: string;
  confidence?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
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

function mapApiRoleToAppRole(role: string): Role {
  const roleMap: Record<string, Role> = {
    admin: 'Администратор',
    controller: 'Контролер',
    control_master: 'Контрольный мастер',
    production_master: 'Производственный мастер',
    'Администратор': 'Администратор',
    'Контролер': 'Контролер',
    'Контрольный мастер': 'Контрольный мастер',
    'Производственный мастер': 'Производственный мастер',
  };

  return roleMap[role] || 'Контролер';
}

function mapAppRoleToApiRole(role: Role): string {
  const roleMap: Record<Role, string> = {
    'Администратор': 'admin',
    'Контролер': 'controller',
    'Контрольный мастер': 'control_master',
    'Производственный мастер': 'production_master',
  };

  return roleMap[role];
}

function mapApiUserToAppUser(user: ApiUserRow): User {
  return {
    id: String(user.id),
    login: user.login,
    password: '',
    name: user.full_name,
    role: mapApiRoleToAppRole(user.role),
  };
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
  if (defect === 'Без дефекта' || count === 0) {
    return 'Дефекты на изображении не обнаружены';
  }

  const percent = (confidence * 100).toFixed(1);
  if (rawLabel && rawLabel !== defect) {
    return `Обнаружен дефект "${defect}" (${rawLabel}) с вероятностью ${percent}%`;
  }

  return `Обнаружен дефект "${defect}" с вероятностью ${percent}%`;
}

async function analyzeDefectViaApi(imageUri: string): Promise<{ defect: DefectClass; confidence: number; summary?: string }> {
  const formData = new FormData();
  formData.append(
    'file',
    {
      uri: imageUri,
      name: `defect_${Date.now()}.jpg`,
      type: 'image/jpeg',
    } as any
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

    const bestPrediction = predictions.reduce((best, current) => {
      const bestConfidence = Number(best?.confidence ?? -1);
      const currentConfidence = Number(current?.confidence ?? -1);
      return currentConfidence > bestConfidence ? current : best;
    });

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

function daysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return formatDate(d);
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

const dbPromise = SQLite.openDatabaseAsync('defect_control.db');

type DbInspectionRow = Omit<Inspection, 'defects'> & {
  defectsJson: string;
};

async function initDb() {
  const db = await dbPromise;
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY NOT NULL,
      login TEXT NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY NOT NULL,
      productName TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      manufactureDate TEXT NOT NULL,
      workerName TEXT NOT NULL,
      status TEXT NOT NULL,
      shipmentNumber TEXT,
      shipmentDate TEXT,
      assignedToController TEXT,
      assignedToControllerId TEXT,
      inspectionAcceptedAt TEXT,
      assemblySentAt TEXT
    );

    CREATE TABLE IF NOT EXISTS inspections (
      id TEXT PRIMARY KEY NOT NULL,
      batchId TEXT NOT NULL,
      inspector TEXT NOT NULL,
      date TEXT NOT NULL,
      visualConclusion TEXT NOT NULL,
      geometryConclusion TEXT NOT NULL,
      defectsJson TEXT NOT NULL,
      acceptedCount INTEGER NOT NULL,
      rejectedCount INTEGER NOT NULL,
      comment TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shifts (
      id TEXT PRIMARY KEY NOT NULL,
      date TEXT NOT NULL,
      employeeName TEXT NOT NULL,
      role TEXT NOT NULL
    );
  `);
}

async function seedDbIfNeeded(
  users: User[],
  workers: Worker[],
  batches: Batch[],
  inspections: Inspection[],
  shifts: Shift[]
) {
  const db = await dbPromise;
  const usersCount = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM users');
  if ((usersCount?.count ?? 0) > 0) return;

  for (const user of users) {
    await db.runAsync(
      'INSERT INTO users (id, login, password, name, role) VALUES (?, ?, ?, ?, ?)',
      user.id,
      user.login,
      user.password,
      user.name,
      user.role
    );
  }

  for (const worker of workers) {
    await db.runAsync('INSERT INTO workers (id, name) VALUES (?, ?)', worker.id, worker.name);
  }

  for (const batch of batches) {
    await db.runAsync(
      `INSERT INTO batches (
        id, productName, quantity, manufactureDate, workerName, status,
        shipmentNumber, shipmentDate, assignedToController, assignedToControllerId,
        inspectionAcceptedAt, assemblySentAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      batch.id,
      batch.productName,
      batch.quantity,
      batch.manufactureDate,
      batch.workerName,
      batch.status,
      batch.shipmentNumber ?? null,
      batch.shipmentDate ?? null,
      batch.assignedToController ?? null,
      batch.assignedToControllerId ?? null,
      batch.inspectionAcceptedAt ?? null,
      batch.assemblySentAt ?? null
    );
  }

  for (const inspection of inspections) {
    await db.runAsync(
      `INSERT INTO inspections (
        id, batchId, inspector, date, visualConclusion, geometryConclusion,
        defectsJson, acceptedCount, rejectedCount, comment
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      inspection.id,
      inspection.batchId,
      inspection.inspector,
      inspection.date,
      inspection.visualConclusion,
      inspection.geometryConclusion,
      JSON.stringify(inspection.defects),
      inspection.acceptedCount,
      inspection.rejectedCount,
      inspection.comment
    );
  }

  for (const shift of shifts) {
    await db.runAsync(
      'INSERT INTO shifts (id, date, employeeName, role) VALUES (?, ?, ?, ?)',
      shift.id,
      shift.date,
      shift.employeeName,
      shift.role
    );
  }
}

async function loadAllDb() {
  const db = await dbPromise;

  const users = await db.getAllAsync<User>('SELECT * FROM users ORDER BY name');
  const workers = await db.getAllAsync<Worker>('SELECT * FROM workers ORDER BY name');
  const batches = await db.getAllAsync<Batch>(
    'SELECT * FROM batches ORDER BY manufactureDate DESC, id DESC'
  );
  const inspectionRows = await db.getAllAsync<DbInspectionRow>(
    'SELECT * FROM inspections ORDER BY date DESC, id DESC'
  );
  const shifts = await db.getAllAsync<Shift>('SELECT * FROM shifts ORDER BY date DESC, id DESC');

  const inspections: Inspection[] = inspectionRows.map((row) => ({
    id: row.id,
    batchId: row.batchId,
    inspector: row.inspector,
    date: row.date,
    visualConclusion: row.visualConclusion,
    geometryConclusion: row.geometryConclusion,
    defects: row.defectsJson ? JSON.parse(row.defectsJson) : [],
    acceptedCount: row.acceptedCount,
    rejectedCount: row.rejectedCount,
    comment: row.comment,
  }));

  return { users, workers, batches, inspections, shifts };
}


async function syncUsersFromServer() {
  const response = await fetch(`${API_URL}/api/users`);
  const rawText = await response.text();

  let data: any = [];
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error('Не удалось разобрать список пользователей с сервера');
  }

  const rows = Array.isArray(data) ? data : Array.isArray(data?.users) ? data.users : [];

  if (!response.ok || !Array.isArray(rows)) {
    throw new Error('Не удалось получить список пользователей с сервера');
  }

  return rows.map((item: ApiUserRow) => mapApiUserToAppUser(item));
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
    status === 'Готова к проверке'
      ? '#2563eb'
      : status === 'Проверена'
      ? '#15803d'
      : '#6b7280';

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
  const initialUsers: User[] = [
    { id: 'u1', login: 'master.p', password: '1234', name: 'Александр', role: 'Производственный мастер' },
    { id: 'u2', login: 'lilia.i', password: '1234', name: 'Лилия', role: 'Контролер' },
    { id: 'u5', login: 'olga.k', password: '1234', name: 'Ольга', role: 'Контролер' },
    { id: 'u3', login: 'master.c', password: '1234', name: 'Елизавета', role: 'Контрольный мастер' },
    { id: 'u4', login: 'admin', password: '1234', name: 'Администратор', role: 'Администратор' },
  ];

  const initialWorkers: Worker[] = [
    { id: 'w1', name: 'Сергей Волков' },
    { id: 'w2', name: 'Олег Морозов' },
    { id: 'w3', name: 'Павел Егоров' },
    { id: 'w4', name: 'Илья Фомин' },
  ];

  const initialBatches: Batch[] = [
  {
    id: 'B-1001',
    productName: 'Втулка стальная',
    quantity: 120,
    manufactureDate: daysAgo(10),
    workerName: 'Сергей Волков',
    status: 'Готова к проверке',
  },
  {
    id: 'B-1002',
    productName: 'Фланец',
    quantity: 80,
    manufactureDate: daysAgo(2),
    workerName: 'Олег Морозов',
    status: 'Проверена',
    assignedToController: 'Лилия Иванова',
    assignedToControllerId: 'u2',
    inspectionAcceptedAt: daysAgo(1),
  },
  {
    id: 'B-1003',
    productName: 'Шайба усиленная',
    quantity: 60,
    manufactureDate: daysAgo(40),
    workerName: 'Павел Егоров',
    status: 'Отправлено на сборку',
    shipmentNumber: 'SHIP-4021',
    shipmentDate: daysAgo(35),
    assemblySentAt: daysAgo(35),
  },
];

  const initialInspections: Inspection[] = [
    {
      id: 'I-1',
      batchId: 'B-1002',
      inspector: 'Лилия',
      date: daysAgo(1),
      visualConclusion: 'Выявлены единичные поверхностные царапины на части изделий партии.',
      geometryConclusion: 'Отклонения в пределах допуска.',
      defects: [
        {
          id: 'D-1',
          defectClass: 'Царапина',
          confidence: 0.92,
          affectedCount: 3,
          comment: 'Поверхностный дефект.',
        },
      ],
      acceptedCount: 77,
      rejectedCount: 3,
      comment: 'Требуется повторный осмотр части партии.',
    },
  ];

const initialShifts: Shift[] = [
  { id: 's1', date: todayStr(), employeeName: 'Сергей Волков', role: 'Рабочий' },
  { id: 's2', date: todayStr(), employeeName: 'Олег Морозов', role: 'Рабочий' },
  { id: 's3', date: todayStr(), employeeName: 'Павел Егоров', role: 'Рабочий' },
  { id: 's4', date: todayStr(), employeeName: 'Лилия', role: 'Контролер' },
  { id: 's5', date: todayStr(), employeeName: 'Александр', role: 'Производственный мастер' },
  { id: 's6', date: todayStr(), employeeName: 'Елизавета', role: 'Контрольный мастер' },
];

  const [users, setUsers] = useState<User[]>(initialUsers);
  const [workers, setWorkers] = useState<Worker[]>(initialWorkers);
  const [batches, setBatches] = useState<Batch[]>(initialBatches);
  const [inspections, setInspections] = useState<Inspection[]>(initialInspections);
  const [shifts, setShifts] = useState<Shift[]>(initialShifts);
  const [dbReady, setDbReady] = useState(false);

  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [, setToken] = useState('');
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [screen, setScreen] = useState<
    'dashboard' | 'batches' | 'inspection' | 'report' | 'schedule' | 'admin'
  >('dashboard');
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);

  const [newBatch, setNewBatch] = useState({
    productName: '',
    quantity: '1',
    manufactureDate: todayStr(),
    workerName: '',
  });

  const [adminUserForm, setAdminUserForm] = useState<{
    name: string;
    login: string;
    password: string;
    role: Role;
  }>({
    name: '',
    login: '',
    password: '',
    role: 'Контролер',
  });

  const [passwordDrafts, setPasswordDrafts] = useState<Record<string, string>>({});

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
  const [shiftRole, setShiftRole] = useState<ShiftRole>('Рабочий');

  const [reportDateFrom, setReportDateFrom] = useState('');
  const [reportDateTo, setReportDateTo] = useState('');


  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        await initDb();
        await seedDbIfNeeded(
          initialUsers,
          initialWorkers,
          initialBatches,
          initialInspections,
          initialShifts
        );
        const data = await loadAllDb();

        if (!mounted) return;
        let nextUsers = data.users;
        try {
          nextUsers = await syncUsersFromServer();
        } catch (syncError) {
          console.warn('Не удалось синхронизировать пользователей с сервера, используем локальные данные');
        }

        setUsers(nextUsers);
        setWorkers(data.workers);
        setBatches(data.batches);
        setInspections(data.inspections);
        setShifts(data.shifts);
        setPasswordDrafts(Object.fromEntries(nextUsers.map((u) => [u.id, u.password || ''])));
        setDbReady(true);
      } catch (error) {
        console.error('DB init error', error);
        Alert.alert('Ошибка', 'Не удалось инициализировать базу данных');
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  const activeBatch = useMemo(
    () => batches.find((b) => b.id === selectedBatchId) || null,
    [batches, selectedBatchId]
  );

  const currentMonthBatches = useMemo(() => {
    return batches.filter((b) => isCurrentMonth(b.manufactureDate));
  }, [batches]);

const stats = useMemo(() => {
  const total = currentMonthBatches.length;
  const readyCheck = currentMonthBatches.filter((b) => b.status === 'Готова к проверке').length;
  const checked = currentMonthBatches.filter((b) => b.status === 'Проверена').length;
  const sentToAssembly = currentMonthBatches.filter((b) => b.status === 'Отправлено на сборку').length;
  return { total, readyCheck, checked, sentToAssembly };
}, [currentMonthBatches]);

  const batchInspections = useMemo(() => {
    if (!selectedBatchId) return [];
    return inspections.filter((i) => i.batchId === selectedBatchId);
  }, [inspections, selectedBatchId]);

  const workersOnSelectedDate = useMemo(() => {
    return shifts
      .filter((s) => s.date === newBatch.manufactureDate && s.role === 'Рабочий')
      .map((s) => s.employeeName);
  }, [shifts, newBatch.manufactureDate]);

  const currentUserOnShiftToday = useMemo(() => {
    if (!currentUser) return false;
    const shiftRoleMap: Record<Role, ShiftRole> = {
      'Производственный мастер': 'Производственный мастер',
      Контролер: 'Контролер',
      'Контрольный мастер': 'Контрольный мастер',
      Администратор: 'Производственный мастер',
    };
    const requiredRole = shiftRoleMap[currentUser.role];
    return shifts.some(
      (s) => s.date === todayStr() && s.employeeName === currentUser.name && s.role === requiredRole
    );
  }, [currentUser, shifts]);

const currentAcceptedBatch = useMemo(() => {
  if (!currentUser) return null;
  if (
    currentUser.role !== 'Контролер' &&
    currentUser.role !== 'Контрольный мастер' &&
    currentUser.role !== 'Администратор'
  ) {
    return null;
  }

  return (
    batches.find(
      (b) =>
        b.status === 'Готова к проверке' &&
        !!b.assignedToControllerId &&
        (currentUser.role === 'Администратор' || b.assignedToControllerId === currentUser.id)
    ) || null
  );
}, [batches, currentUser]);

const visibleBatchesPage = useMemo(() => {
  return [...batches]
    .filter((b) => b.status === 'Готова к проверке' || b.status === 'Проверена')
    .sort((a, b) => {
      if (a.status === 'Готова к проверке' && b.status === 'Проверена') return -1;
      if (a.status === 'Проверена' && b.status === 'Готова к проверке') return 1;
      return dateToMs(b.manufactureDate) - dateToMs(a.manufactureDate);
    });
}, [batches]);

const reportBatches = useMemo(() => {
  return batches
    .filter((b) => b.status === 'Отправлено на сборку')
    .filter((b) => {
      const date = b.assemblySentAt || b.shipmentDate || b.manufactureDate;
      return isDateInRange(date, reportDateFrom, reportDateTo);
    })
    .sort(
      (a, b) =>
        dateToMs(b.assemblySentAt || b.shipmentDate || b.manufactureDate) -
        dateToMs(a.assemblySentAt || a.shipmentDate || a.manufactureDate)
    );
}, [batches, reportDateFrom, reportDateTo]);

  const recentArchive = useMemo(() => {
    const monthAgoMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return reportBatches.filter(
      (b) => dateToMs(b.assemblySentAt || b.shipmentDate || b.manufactureDate) >= monthAgoMs
    );
  }, [reportBatches]);

  const folderedArchive = useMemo(() => {
    const monthAgoMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const older = reportBatches.filter(
      (b) => dateToMs(b.assemblySentAt || b.shipmentDate || b.manufactureDate) < monthAgoMs
    );
    const grouped: Record<string, Batch[]> = {};
    older.forEach((b) => {
      const folder = monthFolderName(b.assemblySentAt || b.shipmentDate || b.manufactureDate);
      if (!grouped[folder]) grouped[folder] = [];
      grouped[folder].push(b);
    });
    return grouped;
  }, [reportBatches]);

const manageableShiftRoles: ShiftRole[] = useMemo(() => {
  if (!currentUser) return [];
  if (currentUser.role === 'Производственный мастер') return ['Рабочий'];
  if (currentUser.role === 'Контрольный мастер') return ['Контролер'];
  if (currentUser.role === 'Администратор') {
    return ['Рабочий', 'Контролер', 'Производственный мастер', 'Контрольный мастер'];
  }
  return [];
}, [currentUser]);

const availableShiftEmployeeNames = useMemo(() => {
  if (currentUser?.role === 'Производственный мастер') {
    return workers.map((w) => w.name);
  }

  if (currentUser?.role === 'Контрольный мастер') {
    return users.filter((u) => u.role === 'Контролер').map((u) => u.name);
  }

  if (currentUser?.role === 'Администратор') {
    if (shiftRole === 'Рабочий') return workers.map((w) => w.name);
    if (shiftRole === 'Контролер') return users.filter((u) => u.role === 'Контролер').map((u) => u.name);
    if (shiftRole === 'Производственный мастер') {
      return users.filter((u) => u.role === 'Производственный мастер').map((u) => u.name);
    }
    return users.filter((u) => u.role === 'Контрольный мастер').map((u) => u.name);
  }

  return [];
}, [shiftRole, users, workers, currentUser]);

  const visibleShifts = useMemo(() => {
    let result = shifts;

    if (currentUser?.role === 'Производственный мастер') {
      result = result.filter((s) => s.role === 'Рабочий');
    } else if (currentUser?.role === 'Контрольный мастер') {
      result = result.filter((s) => s.role === 'Контролер');
    }

    return result
      .filter((s) => !shiftDate || s.date === shiftDate)
      .sort((a, b) => `${a.date}-${a.role}-${a.employeeName}`.localeCompare(`${b.date}-${b.role}-${b.employeeName}`));
  }, [shifts, shiftDate, currentUser]);

  const handleLogin = async () => {
    try {
      const response = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ login: login.trim(), password }),
      });

      const rawText = await response.text();

      let data: LoginResponse = { ok: false };
      try {
        data = JSON.parse(rawText) as LoginResponse;
      } catch {
        data = { ok: false, message: rawText || 'Некорректный ответ сервера' };
      }

      if (!response.ok || !data.user || !data.token) {
        Alert.alert('Ошибка', data.message || 'Неверный логин или пароль');
        return;
      }

      const userFromApi: User = {
        id: String(data.user.id),
        login: data.user.login || login.trim(),
        password: '',
        name: data.user.full_name,
        role: mapApiRoleToAppRole(data.user.role),
      };

      setToken(data.token);
      setCurrentUser(userFromApi);
      setScreen('dashboard');

      try {
        const syncedUsers = await syncUsersFromServer();
        setUsers(syncedUsers);
        setPasswordDrafts(Object.fromEntries(syncedUsers.map((u) => [u.id, ''])));
      } catch (syncError) {
        console.warn('Не удалось обновить список пользователей после входа');
      }
    } catch (error) {
      console.error('Login error:', error);
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
  if (!newBatch.productName.trim() || !newBatch.workerName.trim()) {
    Alert.alert('Ошибка', 'Заполните наименование изделия и выберите работника в смене');
    return;
  }

  const batch: Batch = {
    id: uid('B'),
    productName: newBatch.productName.trim(),
    quantity: Number(newBatch.quantity || '0'),
    manufactureDate: newBatch.manufactureDate,
    workerName: newBatch.workerName.trim(),
    status: 'Готова к проверке',
  };

  const db = await dbPromise;
  await db.runAsync(
    `INSERT INTO batches (
      id, productName, quantity, manufactureDate, workerName, status,
      shipmentNumber, shipmentDate, assignedToController, assignedToControllerId,
      inspectionAcceptedAt, assemblySentAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    batch.id,
    batch.productName,
    batch.quantity,
    batch.manufactureDate,
    batch.workerName,
    batch.status,
    null,
    null,
    null,
    null,
    null,
    null
  );

  setBatches((prev) => [batch, ...prev]);
  setNewBatch({
    productName: '',
    quantity: '1',
    manufactureDate: todayStr(),
    workerName: '',
  });

  Alert.alert('Готово', 'Партия создана и отправлена на проверку');
};

const acceptBatchForInspection = async (batchId: string) => {
  if (!currentUser) return;

  if (
    (currentUser.role === 'Контролер' || currentUser.role === 'Контрольный мастер') &&
    !currentUserOnShiftToday
  ) {
    Alert.alert('Смена не назначена', 'Вы не назначены в смену на сегодня');
    return;
  }

  if (currentAcceptedBatch && currentAcceptedBatch.id !== batchId && currentUser.role !== 'Администратор') {
    Alert.alert('Активная партия уже есть', 'Сначала завершите текущую принятую партию');
    return;
  }

  const acceptedAt = todayStr();
  const db = await dbPromise;
  await db.runAsync(
    `UPDATE batches
     SET assignedToController = ?, assignedToControllerId = ?, inspectionAcceptedAt = ?
     WHERE id = ?`,
    currentUser.name,
    currentUser.id,
    acceptedAt,
    batchId
  );

  setBatches((prev) =>
    prev.map((b) =>
      b.id === batchId
        ? {
            ...b,
            assignedToController: currentUser.name,
            assignedToControllerId: currentUser.id,
            inspectionAcceptedAt: acceptedAt,
          }
        : b
    )
  );

  setSelectedBatchId(batchId);
  setScreen('inspection');
};

const markBatchChecked = async (batchId: string) => {
  const db = await dbPromise;
  await db.runAsync(`UPDATE batches SET status = ? WHERE id = ?`, 'Проверена', batchId);
  setBatches((prev) =>
    prev.map((b) => (b.id === batchId ? { ...b, status: 'Проверена' } : b))
  );
};

const sendBatchToAssembly = async (batchId: string) => {
  const sentDate = todayStr();
  const db = await dbPromise;
  await db.runAsync(
    `UPDATE batches
     SET status = ?, assemblySentAt = ?, shipmentDate = ?
     WHERE id = ?`,
    'Отправлено на сборку',
    sentDate,
    sentDate,
    batchId
  );
  setBatches((prev) =>
    prev.map((b) =>
      b.id === batchId
        ? {
            ...b,
            status: 'Отправлено на сборку',
            assemblySentAt: sentDate,
            shipmentDate: sentDate,
          }
        : b
    )
  );
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
    try {
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
        const uri = result.assets[0].uri;
        setInspectionForm((prev) => ({ ...prev, imageUri: uri }));
      }
    } catch {
      Alert.alert('Ошибка', 'Не удалось выбрать изображение');
    }
  };

  const capturePhoto = async () => {
    try {
      const photo = await cameraRef.current?.takePictureAsync({
        quality: 0.7,
      });

      if (!photo?.uri) {
        Alert.alert('Ошибка', 'Не удалось сделать снимок');
        return;
      }

      setInspectionForm((prev) => ({ ...prev, imageUri: photo.uri }));
      setCameraOpen(false);
    } catch {
      Alert.alert('Ошибка', 'Не удалось сделать снимок');
    }
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
      Alert.alert(
        'Ошибка AI-анализа',
        `${message}\n\nПроверьте API_URL в App.tsx и доступность backend-сервера.`
      );
    }
  };

  const addDetectedDefect = () => {
    if (inferenceState.defect === 'Неопределено') {
      Alert.alert('Ошибка', 'Сначала выполните AI-анализ');
      return;
    }

    const affectedCount = Number(inspectionForm.rejectedCount || '0');
    if (affectedCount <= 0) {
      Alert.alert('Ошибка', 'Укажите количество бракованных изделий для этого дефекта');
      return;
    }

    const nextDefect: DefectItem = {
      id: uid('D'),
      defectClass: inferenceState.defect,
      confidence: inferenceState.confidence,
      affectedCount,
      comment: defectComment.trim(),
      imageUri: inspectionForm.imageUri || undefined,
    };

    setDetectedDefects((prev) => [nextDefect, ...prev]);
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

    const record: Inspection = {
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
    };

    const db = await dbPromise;
    await db.runAsync(
      `INSERT INTO inspections (
        id, batchId, inspector, date, visualConclusion, geometryConclusion,
        defectsJson, acceptedCount, rejectedCount, comment
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.batchId,
      record.inspector,
      record.date,
      record.visualConclusion,
      record.geometryConclusion,
      JSON.stringify(record.defects),
      record.acceptedCount,
      record.rejectedCount,
      record.comment
    );
    await db.runAsync(`UPDATE batches SET status = ? WHERE id = ?`, 'Проверена', activeBatch.id);

    setInspections((prev) => [record, ...prev]);
    setBatches((prev) =>
      prev.map((b) => (b.id === activeBatch.id ? { ...b, status: 'Проверена' } : b))
    );

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

    Alert.alert('Готово', 'Результаты контроля сохранены');
  };

  const createAdminUser = async () => {
    if (
      !adminUserForm.name.trim() ||
      !adminUserForm.login.trim() ||
      !adminUserForm.password.trim()
    ) {
      Alert.alert('Ошибка', 'Заполните имя, логин и пароль');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/api/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          full_name: adminUserForm.name.trim(),
          login: adminUserForm.login.trim(),
          password: adminUserForm.password.trim(),
          role: mapAppRoleToApiRole(adminUserForm.role),
        }),
      });

      const data = await response.json();

      const createdUserPayload = data?.user ?? data;

      if (!response.ok || !createdUserPayload || !createdUserPayload.id) {
        Alert.alert('Ошибка', data?.message || 'Не удалось добавить пользователя');
        return;
      }

      const createdUser = mapApiUserToAppUser(createdUserPayload);
      setUsers((prev) => [...prev, createdUser]);
      setPasswordDrafts((prev) => ({ ...prev, [createdUser.id]: '' }));
      setAdminUserForm({
        name: '',
        login: '',
        password: '',
        role: 'Контролер',
      });

      Alert.alert('Готово', 'Пользователь добавлен');
    } catch (error) {
      console.error('Create user error:', error);
      Alert.alert('Ошибка', 'Не удалось добавить пользователя на сервере');
    }
  };

  const updateUserPassword = async (userId: string) => {
    const nextPassword = (passwordDrafts[userId] || '').trim();

    if (!nextPassword) {
      Alert.alert('Ошибка', 'Введите новый пароль');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/api/users/${userId}/password`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password: nextPassword }),
      });

      const data = await response.json();

      if (!response.ok || data?.ok === false) {
        Alert.alert('Ошибка', data?.message || 'Не удалось обновить пароль');
        return;
      }

      setPasswordDrafts((prev) => ({ ...prev, [userId]: '' }));
      Alert.alert('Готово', 'Пароль обновлён');
    } catch (error) {
      console.error('Update password error:', error);
      Alert.alert('Ошибка', 'Не удалось обновить пароль на сервере');
    }
  };

  const addWorker = async () => {
    const name = newWorkerName.trim();
    if (!name) {
      Alert.alert('Ошибка', 'Введите имя рабочего');
      return;
    }

    const exists = workers.some((w) => w.name.toLowerCase() === name.toLowerCase());
    if (exists) {
      Alert.alert('Ошибка', 'Такой рабочий уже существует');
      return;
    }

    const worker = { id: uid('W'), name };
    const db = await dbPromise;
    await db.runAsync('INSERT INTO workers (id, name) VALUES (?, ?)', worker.id, worker.name);

    setWorkers((prev) => [...prev, worker]);
    setNewWorkerName('');
    Alert.alert('Готово', 'Рабочий добавлен');
  };

  const removeWorker = async (workerId: string) => {
    const worker = workers.find((w) => w.id === workerId);
    if (!worker) return;

    const db = await dbPromise;
    await db.runAsync('DELETE FROM workers WHERE id = ?', workerId);
    await db.runAsync('DELETE FROM shifts WHERE employeeName = ? AND role = ?', worker.name, 'Рабочий');

    setWorkers((prev) => prev.filter((w) => w.id !== workerId));
    setShifts((prev) => prev.filter((s) => !(s.employeeName === worker.name && s.role === 'Рабочий')));
    Alert.alert('Готово', 'Рабочий удалён');
  };

  const addShift = async () => {
    if (!shiftDate || !shiftEmployeeName.trim()) {
      Alert.alert('Ошибка', 'Укажите дату, сотрудника и роль');
      return;
    }

    if (!manageableShiftRoles.includes(shiftRole)) {
      Alert.alert('Нет доступа', 'Вы не можете назначать эту роль в смене');
      return;
    }

    const exists = shifts.some(
      (s) =>
        s.date === shiftDate &&
        s.employeeName === shiftEmployeeName.trim() &&
        s.role === shiftRole
    );

    if (exists) {
      Alert.alert('Уже существует', 'Такая смена уже назначена');
      return;
    }

    const shift: Shift = {
      id: uid('S'),
      date: shiftDate,
      employeeName: shiftEmployeeName.trim(),
      role: shiftRole,
    };

    const db = await dbPromise;
    await db.runAsync(
      'INSERT INTO shifts (id, date, employeeName, role) VALUES (?, ?, ?, ?)',
      shift.id,
      shift.date,
      shift.employeeName,
      shift.role
    );

    setShifts((prev) => [shift, ...prev]);
    Alert.alert('Готово', 'Смена назначена');
  };

  const removeShift = async (shiftId: string) => {
    const db = await dbPromise;
    await db.runAsync('DELETE FROM shifts WHERE id = ?', shiftId);
    setShifts((prev) => prev.filter((s) => s.id !== shiftId));
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
        <Text style={styles.text}>Дата изготовления: {batch.manufactureDate}</Text>
        <Text style={styles.text}>Работник: {batch.workerName}</Text>
        {!!batch.assignedToController && (
          <Text style={styles.text}>Контролер: {batch.assignedToController}</Text>
        )}
        {!!batch.assemblySentAt && (
          <Text style={styles.text}>Дата отправки на сборку: {batch.assemblySentAt}</Text>
        )}

        {lastInspection && (
          <View style={styles.cardSoft}>
            <Text style={styles.cardSubTitle}>Последний отчет</Text>
            <Text style={styles.text}>Дата контроля: {lastInspection.date}</Text>
            <Text style={styles.text}>Проверил: {lastInspection.inspector}</Text>
            <Text style={styles.text}>Годных: {lastInspection.acceptedCount}</Text>
            <Text style={styles.text}>Бракованных: {lastInspection.rejectedCount}</Text>
          </View>
        )}

        <View style={styles.actionsWrap}>
          {(currentUser?.role === 'Производственный мастер' || currentUser?.role === 'Администратор') &&
            batch.status === 'Проверена' && (
              <Pressable style={styles.primaryButtonSmall} onPress={() => sendBatchToAssembly(batch.id)}>
                <Text style={styles.primaryButtonText}>Отправить на сборку</Text>
              </Pressable>
            )}
        </View>
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
    currentUser?.role === 'Производственный мастер' ||
    currentUser?.role === 'Контрольный мастер' ||
    currentUser?.role === 'Администратор';

  if (!dbReady) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={[styles.container, { justifyContent: 'center', flex: 1 }]}>
          <View style={styles.phone}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Загрузка данных...</Text>
              <Text style={styles.text}>Инициализация локальной базы SQLite.</Text>
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
              <TextInput
                style={styles.input}
                secureTextEntry
                value={password}
                onChangeText={setPassword}
              />

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
                    onChangeText={(value) =>
                      setNewBatch((prev) => ({ ...prev, manufactureDate: value }))
                    }
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={COLORS.muted}
                  />

                  <Label text="Рабочий в смене" />
                  <View style={styles.roleRow}>
                    {workersOnSelectedDate.length === 0 ? (
                      <Text style={styles.text}>На эту дату нет назначенных рабочих.</Text>
                    ) : (
                      workersOnSelectedDate.map((name) => (
                        <Pressable
                          key={name}
                          style={[
                            styles.roleButton,
                            newBatch.workerName === name && styles.roleButtonActive,
                          ]}
                          onPress={() => setNewBatch((prev) => ({ ...prev, workerName: name }))}
                        >
                          <Text
                            style={[
                              styles.roleButtonText,
                              newBatch.workerName === name && styles.roleButtonTextActive,
                            ]}
                          >
                            {name}
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

              {!currentAcceptedBatch ? (
                <View style={styles.card}>
                  <Text style={styles.text}>Активной принятой партии нет.</Text>

                  {(currentUser.role === 'Контролер' || currentUser.role === 'Контрольный мастер' || currentUser.role === 'Администратор') && (
                    <>
                      <Text style={[styles.text, { marginTop: 10 }]}>Партии, готовые к проверке:</Text>
                      {batches
                        .filter((b) => b.status === 'Готова к проверке')
                        .map((batch) => (
                          <View key={batch.id} style={styles.historyItem}>
                            <Text style={styles.text}>
                              <Text style={styles.textBold}>{batch.productName}</Text>
                            </Text>
                            <Text style={styles.text}>Партия: {batch.id}</Text>
                            <Text style={styles.text}>Количество: {batch.quantity}</Text>
                            <Pressable
                              style={styles.primaryButton}
                              onPress={() => acceptBatchForInspection(batch.id)}
                            >
                              <Text style={styles.primaryButtonText}>Принять партию</Text>
                            </Pressable>
                          </View>
                        ))}
                    </>
                  )}
                </View>
              ) : (
                <>
                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>{currentAcceptedBatch.productName}</Text>
                    <Text style={styles.text}>Партия: {currentAcceptedBatch.id}</Text>
                    <Text style={styles.text}>Количество: {currentAcceptedBatch.quantity}</Text>
                    <Text style={styles.text}>Статус: {currentAcceptedBatch.status}</Text>
                    <Text style={styles.text}>Контролер: {currentAcceptedBatch.assignedToController}</Text>
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
                        Уверенность:{' '}
                        <Text style={styles.textBold}>
                          {(inferenceState.confidence * 100).toFixed(1)}%
                        </Text>
                      </Text>
                      {!!inferenceState.summary && (
                        <Text style={[styles.text, { marginTop: 8 }]}>
                          Комментарий AI: <Text style={styles.textBold}>{inferenceState.summary}</Text>
                        </Text>
                      )}
                    </View>

                    <Label text="Комментарий к найденному дефекту" />
                    <TextInput
                      style={styles.textarea}
                      multiline
                      value={defectComment}
                      onChangeText={setDefectComment}
                    />

                    <Label text="Количество изделий с этим дефектом" />
                    <TextInput
                      style={styles.input}
                      keyboardType="numeric"
                      value={inspectionForm.rejectedCount}
                      onChangeText={(value) =>
                        setInspectionForm((prev) => ({ ...prev, rejectedCount: value }))
                      }
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
                            <Text style={styles.text}>
                              Уверенность: {(item.confidence * 100).toFixed(1)}%
                            </Text>
                            <Text style={styles.text}>
                              Количество изделий с этим дефектом: {item.affectedCount}
                            </Text>
                            <Text style={styles.text}>Комментарий: {item.comment || '—'}</Text>

                            {!!item.imageUri && (
                              <Image source={{ uri: item.imageUri }} style={styles.imagePreviewSmall} />
                            )}

                            <Pressable
                              style={styles.secondaryButton}
                              onPress={() => removeDetectedDefect(item.id)}
                            >
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
                      onChangeText={(value) =>
                        setInspectionForm((prev) => ({ ...prev, visualConclusion: value }))
                      }
                    />

                    <Label text="Заключение по конструктивным параметрам" />
                    <TextInput
                      style={styles.textarea}
                      multiline
                      value={inspectionForm.geometryConclusion}
                      onChangeText={(value) =>
                        setInspectionForm((prev) => ({ ...prev, geometryConclusion: value }))
                      }
                    />

                    <Label text="Годных изделий" />
                    <TextInput
                      style={styles.input}
                      keyboardType="numeric"
                      value={inspectionForm.acceptedCount}
                      onChangeText={(value) =>
                        setInspectionForm((prev) => ({ ...prev, acceptedCount: value }))
                      }
                    />

                    <Label text="Общий комментарий по партии" />
                    <TextInput
                      style={styles.textarea}
                      multiline
                      value={inspectionForm.comment}
                      onChangeText={(value) =>
                        setInspectionForm((prev) => ({ ...prev, comment: value }))
                      }
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
                          <Text style={styles.text}>
                            <Text style={styles.textBold}>Дата:</Text> {item.date}
                          </Text>
                          <Text style={styles.text}>
                            <Text style={styles.textBold}>Контролер:</Text> {item.inspector}
                          </Text>
                          <Text style={styles.text}>
                            <Text style={styles.textBold}>Визуально:</Text> {item.visualConclusion}
                          </Text>
                          <Text style={styles.text}>
                            <Text style={styles.textBold}>Геометрия:</Text> {item.geometryConclusion}
                          </Text>
                          <Text style={styles.text}>
                            <Text style={styles.textBold}>Годных:</Text> {item.acceptedCount}
                          </Text>
                          <Text style={styles.text}>
                            <Text style={styles.textBold}>Брак:</Text> {item.rejectedCount}
                          </Text>
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
                  <Text style={styles.text}>Нет отчетов за последний месяц.</Text>
                ) : (
                  recentArchive.map((batch) => renderBatchCard(batch))
                )}
              </View>

              <View style={styles.card}>
                <Text style={styles.cardTitle}>Архив по месяцам</Text>
                {Object.keys(folderedArchive).length === 0 ? (
                  <Text style={styles.text}>Архивных отчетов старше месяца нет.</Text>
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

                <Label text="Роль в смене" />
                <View style={styles.roleRow}>
                  {manageableShiftRoles.map((role) => (
                    <Pressable
                      key={role}
                      style={[styles.roleButton, shiftRole === role && styles.roleButtonActive]}
                      onPress={() => {
                        setShiftRole(role);
                        setShiftEmployeeName('');
                      }}
                    >
                      <Text
                        style={[
                          styles.roleButtonText,
                          shiftRole === role && styles.roleButtonTextActive,
                        ]}
                      >
                        {role}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                <Label text="Сотрудник" />
                <View style={styles.roleRow}>
                  {availableShiftEmployeeNames.map((name) => (
                    <Pressable
                      key={name}
                      style={[
                        styles.roleButton,
                        shiftEmployeeName === name && styles.roleButtonActive,
                      ]}
                      onPress={() => setShiftEmployeeName(name)}
                    >
                      <Text
                        style={[
                          styles.roleButtonText,
                          shiftEmployeeName === name && styles.roleButtonTextActive,
                        ]}
                      >
                        {name}
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
                      <Text style={styles.text}>
                        <Text style={styles.textBold}>{shift.date}</Text>
                      </Text>
                      <Text style={styles.text}>Сотрудник: {shift.employeeName}</Text>
                      <Text style={styles.text}>Роль: {shift.role}</Text>
                      <Pressable
                        style={styles.secondaryButton}
                        onPress={() => removeShift(shift.id)}
                      >
                        <Text style={styles.secondaryButtonText}>Удалить смену</Text>
                      </Pressable>
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
                <Text style={styles.cardTitle}>Добавление пользователя</Text>

                <Label text="Имя пользователя" />
                <TextInput
                  style={styles.input}
                  value={adminUserForm.name}
                  onChangeText={(value) => setAdminUserForm((prev) => ({ ...prev, name: value }))}
                />

                <Label text="Логин" />
                <TextInput
                  style={styles.input}
                  value={adminUserForm.login}
                  onChangeText={(value) => setAdminUserForm((prev) => ({ ...prev, login: value }))}
                />

                <Label text="Пароль" />
                <TextInput
                  style={styles.input}
                  secureTextEntry
                  value={adminUserForm.password}
                  onChangeText={(value) =>
                    setAdminUserForm((prev) => ({ ...prev, password: value }))
                  }
                />

                <Label text="Роль" />
                <View style={styles.roleRow}>
                  {(['Производственный мастер', 'Контролер', 'Контрольный мастер', 'Администратор'] as Role[]).map(
                    (role) => (
                      <Pressable
                        key={role}
                        style={[
                          styles.roleButton,
                          adminUserForm.role === role && styles.roleButtonActive,
                        ]}
                        onPress={() => setAdminUserForm((prev) => ({ ...prev, role }))}
                      >
                        <Text
                          style={[
                            styles.roleButtonText,
                            adminUserForm.role === role && styles.roleButtonTextActive,
                          ]}
                        >
                          {role}
                        </Text>
                      </Pressable>
                    )
                  )}
                </View>

                <Pressable style={styles.primaryButton} onPress={createAdminUser}>
                  <Text style={styles.primaryButtonText}>Добавить пользователя</Text>
                </Pressable>
              </View>

              <View style={styles.card}>
                <Text style={styles.cardTitle}>Пользователи</Text>

                {users.map((u) => (
                  <View key={u.id} style={styles.historyItem}>
                    <Text style={styles.text}>
                      <Text style={styles.textBold}>{u.name}</Text>
                    </Text>
                    <Text style={styles.text}>Логин: {u.login}</Text>
                    <Text style={styles.text}>Роль: {u.role}</Text>

                    <Label text="Новый пароль" />
                    <TextInput
                      style={styles.input}
                      secureTextEntry
                      value={passwordDrafts[u.id] ?? ''}
                      onChangeText={(value) =>
                        setPasswordDrafts((prev) => ({ ...prev, [u.id]: value }))
                      }
                    />

                    <Pressable style={styles.secondaryButton} onPress={() => updateUserPassword(u.id)}>
                      <Text style={styles.secondaryButtonText}>Сохранить пароль</Text>
                    </Pressable>
                  </View>
                ))}
              </View>

              <View style={styles.card}>
                <Text style={styles.cardTitle}>Рабочие</Text>

                <Label text="Новый рабочий" />
                <TextInput
                  style={styles.input}
                  value={newWorkerName}
                  onChangeText={setNewWorkerName}
                />

                <Pressable style={styles.primaryButton} onPress={addWorker}>
                  <Text style={styles.primaryButtonText}>Добавить рабочего</Text>
                </Pressable>

                {workers.map((worker) => (
                  <View key={worker.id} style={styles.historyItem}>
                    <Text style={styles.text}>{worker.name}</Text>
                    <Pressable
                      style={styles.secondaryButton}
                      onPress={() => removeWorker(worker.id)}
                    >
                      <Text style={styles.secondaryButtonText}>Удалить рабочего</Text>
                    </Pressable>
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
  safeArea: {
    flex: 1,
    backgroundColor: '#020617',
  },
  container: {
    padding: 16,
    alignItems: 'center',
  },
  phone: {
    width: '100%',
    maxWidth: 520,
    backgroundColor: COLORS.bg,
    borderRadius: 24,
    padding: 16,
    minHeight: '100%',
  },
  headerBlock: {
    marginBottom: 18,
  },
  title: {
    color: COLORS.text,
    fontSize: 30,
    fontWeight: '800',
  },
  subtitle: {
    color: COLORS.muted,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 6,
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  topRole: {
    color: COLORS.accent2,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  topName: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: '700',
    marginTop: 2,
  },
  navRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 16,
    marginBottom: 18,
  },
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
  tabButtonActive: {
    backgroundColor: '#1d4ed8',
  },
  tabButtonText: {
    color: COLORS.text,
    fontWeight: '600',
  },
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
  cardTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 10,
  },
  cardSubTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 8,
  },
  text: {
    color: COLORS.text,
    fontSize: 14,
    lineHeight: 20,
    marginVertical: 2,
  },
  textBold: {
    fontWeight: '700',
  },
  label: {
    color: COLORS.muted,
    fontSize: 13,
    marginTop: 8,
    marginBottom: 6,
  },
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
  primaryButtonSmall: {
    backgroundColor: COLORS.accent,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginTop: 8,
    alignItems: 'center',
    marginRight: 8,
    marginBottom: 8,
  },
  primaryButtonText: {
    color: '#052e16',
    fontWeight: '800',
  },
  secondaryButton: {
    backgroundColor: COLORS.soft,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
    marginRight: 8,
    marginBottom: 8,
  },
  secondaryButtonText: {
    color: COLORS.text,
    fontWeight: '700',
  },
  sectionTitle: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 12,
  },
  grid2: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 14,
  },
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
  statValue: {
    fontSize: 28,
    fontWeight: '800',
    color: COLORS.accent2,
  },
  statTitle: {
    marginTop: 6,
    color: COLORS.muted,
    fontSize: 13,
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  badge: {
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginLeft: 8,
  },
  badgeText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '700',
  },
  actionsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 12,
  },
  aiBox: {
    backgroundColor: '#082f49',
    borderWidth: 1,
    borderColor: '#0ea5e9',
    borderRadius: 14,
    padding: 12,
    marginTop: 12,
    marginBottom: 12,
  },
  historyItem: {
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingTop: 10,
    marginTop: 10,
  },
  defectRow: {
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    marginTop: 6,
  },
  previewBox: {
    backgroundColor: '#0b1220',
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 12,
    marginBottom: 12,
  },
  imagePreview: {
    width: '100%',
    height: 260,
    borderRadius: 12,
    marginBottom: 12,
    backgroundColor: '#000',
  },
  imagePreviewSmall: {
    width: '100%',
    height: 180,
    borderRadius: 10,
    marginTop: 8,
    marginBottom: 8,
    backgroundColor: '#000',
  },
  roleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 8,
    marginTop: 4,
  },
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
  roleButtonActive: {
    backgroundColor: COLORS.accent2,
    borderColor: COLORS.accent2,
  },
  roleButtonText: {
    color: COLORS.text,
    fontWeight: '600',
  },
  roleButtonTextActive: {
    color: '#082f49',
    fontWeight: '800',
  },
  cameraScreen: {
    flex: 1,
    backgroundColor: 'black',
  },
  cameraPreview: {
    flex: 1,
  },
  cameraOverlay: {
    flex: 1,
    justifyContent: 'space-between',
    padding: 20,
    backgroundColor: 'rgba(0,0,0,0.15)',
  },
  cameraTitle: {
    color: 'white',
    fontSize: 20,
    fontWeight: '700',
    marginTop: 20,
  },
  cameraActions: {
    marginBottom: 24,
  },
  captureButton: {
    backgroundColor: 'white',
    borderRadius: 16,Проверьте API_URL в App.tsx и доступность backend-сервера.
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  captureButtonText: {
    color: '#111827',
    fontWeight: '800',
    fontSize: 16,
  },
});