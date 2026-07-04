/**
 * ============================================================
 * DASHBOARD SERVICE
 * ============================================================
 * Semua query Supabase khusus untuk halaman Dasbor dikumpulkan
 * di sini. Frontend tinggal import fungsi — tidak ada query
 * berserakan di dalam HTML/view file.
 * ============================================================
 */

import { getSupabaseClient, getCurrentUserId } from "./supabase.service.js";

/**
 * getDashboardStats
 * Mengambil 4 angka stat card sekaligus lewat view
 * v_teacher_dashboard_stats (RLS otomatis membatasi ke guru
 * yang sedang login).
 *
 * @returns {Promise<{
 *   sessions_today: number,
 *   students_present_today: number,
 *   total_students: number,
 *   ungraded_tasks: number,
 *   avg_score: number|null
 * }|null>}
 */
export async function getDashboardStats() {
  const supabase = await getSupabaseClient();

  const { data, error } = await supabase
    .from("v_teacher_dashboard_stats")
    .select("*")
    .single();

  if (error) {
    console.error("getDashboardStats error:", error.message);
    return null;
  }

  return data;
}

/**
 * getTodaySchedules
 * Mengambil jadwal mengajar guru yang sedang login untuk hari ini,
 * diurutkan dari jam paling pagi, beserta nama kelas & mata pelajaran.
 *
 * @returns {Promise<Array>}
 */
export async function getTodaySchedules() {
  const supabase = await getSupabaseClient();

  // Format tanggal hari ini ke 'YYYY-MM-DD' tanpa library date tambahan
  const today = new Date().toISOString().split("T")[0];

  const { data, error } = await supabase
    .from("schedules")
    .select(`
      id,
      scheduled_date,
      start_time,
      end_time,
      room,
      classes ( name ),
      subjects ( name )
    `)
    .eq("scheduled_date", today)
    .order("start_time", { ascending: true });

  if (error) {
    console.error("getTodaySchedules error:", error.message);
    return [];
  }

  return data ?? [];
}

/**
 * getActionItems
 * Gabungan hal yang perlu ditindaklanjuti guru hari ini:
 * - Jadwal yang sudah lewat tapi belum diabsen
 * - Assignment yang belum lengkap dinilai
 * Dipakai di card "Perlu Perhatian" pada dashboard.
 *
 * @returns {Promise<{
 *   unrecordedSchedules: Array<{ id, subject, className, time }>,
 *   ungradedAssignments: Array<{ id, title, className, missing, total }>
 * }>}
 */
export async function getActionItems(isAdmin = false) {
  const supabase = await getSupabaseClient();
  const teacherId = await getCurrentUserId();
  const today = new Date().toISOString().split("T")[0];

  // ── Jadwal hari ini yang belum diabsen ──
  let scheduleQuery = supabase
    .from("schedules")
    .select("id, start_time, end_time, classes(name), subjects(name), teachers:teacher_id(full_name)")
    .eq("scheduled_date", today)
    .order("start_time", { ascending: true });

  if (!isAdmin) scheduleQuery = scheduleQuery.eq("teacher_id", teacherId);

  const { data: schedules } = await scheduleQuery;

  let unrecordedSchedules = [];
  if (schedules?.length) {
    const scheduleIds = schedules.map((s) => s.id);
    const { data: attendances } = await supabase
      .from("attendances")
      .select("schedule_id")
      .in("schedule_id", scheduleIds);

    const recordedIds = new Set((attendances ?? []).map((a) => a.schedule_id));
    const now = new Date();

    unrecordedSchedules = schedules
      .filter((s) => {
        if (recordedIds.has(s.id)) return false;
        const startDate = new Date(`${today}T${s.start_time}`);
        return now >= startDate;
      })
      .map((s) => ({
        id:          s.id,
        subject:     s.subjects?.name ?? "—",
        className:   s.classes?.name ?? "—",
        time:        s.start_time.slice(0, 5),
        teacherName: isAdmin ? (s.teachers?.full_name ?? "—") : null,
      }));
  }

  // ── Assignment yang belum lengkap dinilai ──
  let assignmentQuery = supabase
    .from("assignments")
    .select("id, title, class_id, classes(name), teachers:teacher_id(full_name)")
    .is("deleted_at", null);

  if (!isAdmin) assignmentQuery = assignmentQuery.eq("teacher_id", teacherId);

  const { data: assignments } = await assignmentQuery;

  let ungradedAssignments = [];
  if (assignments?.length) {
    const assignmentIds = assignments.map((a) => a.id);
    const classIds = [...new Set(assignments.map((a) => a.class_id))];

    const currentAcademicYear = `${new Date().getFullYear()}/${new Date().getFullYear() + 1}`;

    const [{ data: scoresData }, { data: classStudents }] = await Promise.all([
      supabase.from("scores").select("assignment_id").in("assignment_id", assignmentIds),
      supabase
        .from("class_students")
        .select("class_id, student_id")
        .in("class_id", classIds)
        .eq("academic_year", currentAcademicYear),
    ]);

    const scoreCountMap = {};
    (scoresData ?? []).forEach((s) => {
      scoreCountMap[s.assignment_id] = (scoreCountMap[s.assignment_id] || 0) + 1;
    });

    const classTotalMap = {};
    const seenPerClass = {};
    (classStudents ?? []).forEach((cs) => {
      if (!seenPerClass[cs.class_id]) seenPerClass[cs.class_id] = new Set();
      if (seenPerClass[cs.class_id].has(cs.student_id)) return;
      seenPerClass[cs.class_id].add(cs.student_id);
      classTotalMap[cs.class_id] = (classTotalMap[cs.class_id] || 0) + 1;
    });

    ungradedAssignments = assignments
      .map((a) => {
        const total  = classTotalMap[a.class_id] ?? 0;
        const scored = scoreCountMap[a.id] ?? 0;
        return {
          id: a.id,
          title: a.title,
          className: a.classes?.name ?? "—",
          missing: total - scored,
          total,
          scored,          // ← tambahkan sementara untuk debug
          class_id: a.class_id, // ← tambahkan sementara untuk debug
          teacherName: isAdmin ? (a.teachers?.full_name ?? "—") : null,
        };
      });
      console.log("DEBUG ungradedAssignments (sebelum filter):", ungradedAssignments); // ← tambahkan ini
      console.log("DEBUG v2 ungradedAssignments:", ungradedAssignments);
      ungradedAssignments = ungradedAssignments
      .filter((a) => a.missing > 0)
      .sort((a, b) => b.missing - a.missing)
      .slice(0, 5);
  }

  return { unrecordedSchedules, ungradedAssignments };
}

/**
 * getTopBottomStudents
 * Menghitung rata-rata nilai per siswa (dari semua assignment
 * milik guru yang login), lalu ambil N tertinggi & N terendah.
 * Dipakai di card "Top & Bottom Siswa".
 *
 * @param {number} limit
 * @returns {Promise<{ top: Array<{id,name,avg}>, bottom: Array<{id,name,avg}> }>}
 */
export async function getTopBottomStudents(isAdmin = false, limit = 5) {
  const supabase = await getSupabaseClient();
  const teacherId = await getCurrentUserId();

  let query = supabase
    .from("scores")
    .select("score, students(id, full_name), assignments!inner(teacher_id)");

  if (!isAdmin) query = query.eq("assignments.teacher_id", teacherId);

  const { data, error } = await query;

  if (error || !data?.length) return { top: [], bottom: [] };

  // Agregasi rata-rata per siswa
  const byStudent = {};
  data.forEach((row) => {
    const s = row.students;
    if (!s) return;
    if (!byStudent[s.id]) byStudent[s.id] = { id: s.id, name: s.full_name, total: 0, count: 0 };
    byStudent[s.id].total += row.score;
    byStudent[s.id].count += 1;
  });

  const ranked = Object.values(byStudent)
    .map((s) => ({ id: s.id, name: s.name, avg: Math.round((s.total / s.count) * 10) / 10 }))
    .sort((a, b) => b.avg - a.avg);

  return {
    top:    ranked.slice(0, limit),
    bottom: ranked.slice(-limit).reverse(),
  };
}

/**
 * getWeeklyAttendanceTrend
 * Persentase kehadiran per hari untuk 7 hari terakhir
 * (hanya jadwal milik guru yang login).
 *
 * @returns {Promise<Array<{ date: string, percent: number }>>}
 */
export async function getWeeklyAttendanceTrend(isAdmin = false) {
  const supabase = await getSupabaseClient();
  const teacherId = await getCurrentUserId();

  const today = new Date();
  const from  = new Date();
  from.setDate(today.getDate() - 6);
  const fromStr = from.toISOString().split("T")[0];
  const toStr   = today.toISOString().split("T")[0];

  let query = supabase
    .from("attendances")
    .select("status, schedules!inner(scheduled_date, teacher_id)")
    .gte("schedules.scheduled_date", fromStr)
    .lte("schedules.scheduled_date", toStr);

  if (!isAdmin) query = query.eq("schedules.teacher_id", teacherId);

  const { data } = await query;

  const byDate = {};
  for (let i = 0; i < 7; i++) {
    const d = new Date(from);
    d.setDate(from.getDate() + i);
    const key = d.toISOString().split("T")[0];
    byDate[key] = { hadir: 0, total: 0 };
  }

  (data ?? []).forEach((row) => {
    const date = row.schedules.scheduled_date;
    if (!byDate[date]) return;
    byDate[date].total += 1;
    if (row.status === "hadir") byDate[date].hadir += 1;
  });

  return Object.entries(byDate).map(([date, v]) => ({
    date,
    percent: v.total > 0 ? Math.round((v.hadir / v.total) * 100) : 0,
  }));
}

/**
 * getMonthScheduleDates
 * Ambil tanggal-tanggal dalam sebulan yang punya jadwal mengajar
 * (untuk penanda titik di mini calendar).
 *
 * @param {number} year
 * @param {number} month - 1-12
 * @returns {Promise<Set<string>>} set tanggal "YYYY-MM-DD"
 */
export async function getMonthScheduleDates(year, month, isAdmin = false) {
  const supabase = await getSupabaseClient();
  const teacherId = await getCurrentUserId();

  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${String(month).padStart(2, "0")}-${lastDay}`;

  let query = supabase
    .from("schedules")
    .select("scheduled_date")
    .gte("scheduled_date", from)
    .lte("scheduled_date", to);

  if (!isAdmin) query = query.eq("teacher_id", teacherId);

  const { data } = await query;

  return new Set((data ?? []).map((s) => s.scheduled_date));
}

