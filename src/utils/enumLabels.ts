import type { Lang } from '../context/LanguageContext';

/**
 * Arabic display labels for the fixed values the console stores and compares.
 * DISPLAY ONLY: the stored/compared value is never changed. English mode and any
 * value not listed here come back exactly as given, except for the few values in
 * EN_LABELS below that are shown under a different English name.
 */
const LABELS: Record<string, Record<string, string>> = {
  bookingStatus: { 'Pending': 'قيد الانتظار', 'Checked In': 'تم تسجيل الحضور', 'In Progress': 'جارٍ الآن',
                   'Completed': 'مكتمل', 'Cancelled': 'ملغى', 'Waiting': 'في الانتظار', 'Called': 'تم النداء' },
  payment:       { 'Paid': 'مدفوع', 'Unpaid': 'غير مدفوع', 'Refunded': 'مُسترد', 'Deposit Paid': 'عربون مدفوع' },
  source:        { 'Website': 'الموقع', 'Walk-in': 'زيارة مباشرة', 'Admin': 'الإدارة' },
  category:      { 'Workshops': 'الورش', 'Events/Birthdays': 'الفعاليات وأعياد الميلاد', 'Self-Guided': 'ذاتي التوجيه' },
  dateScope:     { 'Today': 'اليوم', 'Yesterday': 'أمس', 'This Week': 'هذا الأسبوع', 'All': 'كل السجل' },
  // The two walk-in modes staff choose between; stored as the queue entry's `type`.
  queueType:     { 'Without Instructor': 'بدون مدرب', 'With Instructor': 'مع مدرب' },
  // Status of a configured studio room or café table (studio_resources.status).
  resourceStatus: { 'Active': 'نشط', 'Inactive': 'غير نشط', 'Maintenance': 'قيد الصيانة' },
  // Making stages of a pottery piece (pipeline_stages.name). Stage names are
  // renamable in Settings, so a renamed or custom stage falls through as typed.
  pieceStatus:   { 'Created': 'تم الإنشاء', 'First Burn and Colored': 'وقت الفرن',
                   'Ready for Pickup': 'جاهزة للاستلام', 'Collected': 'تم الاستلام', 'Broken': 'مكسورة' },
  // How a broken piece was resolved; stored inside the reason text ("Resolved: Replaced").
  resolutionType: { 'Replaced': 'تم الاستبدال', 'Refunded': 'تم الاسترداد', 'Other': 'أخرى' },
  // What a completed visit was (derived in the customer metrics, compared for badge colour).
  visitType:     { 'Birthday Package': 'باقة عيد ميلاد', 'Event': 'فعالية', 'Workshop': 'ورشة',
                   'Live Queue Walk-in': 'زيارة مباشرة (الطابور المباشر)' },
  // customers.status
  customerStatus: { 'Active': 'نشط', 'VIP': 'مميز', 'Inactive': 'غير نشط', 'Blocked': 'محظور' },
  // customers.source (one display site: the duplicate-customer warning)
  customerSource: { 'Website Registration': 'تسجيل عبر الموقع', 'Website Booking': 'حجز عبر الموقع',
                    'Workshop Booking': 'حجز ورشة', 'Event Booking': 'حجز فعالية',
                    'Birthday Package': 'باقة عيد ميلاد', 'Live Queue': 'الطابور المباشر',
                    'Admin Created': 'أنشأته الإدارة', 'Manual Admin Entry': 'إدخال يدوي من الإدارة',
                    'Walk-in': 'زيارة مباشرة' },
  // workshops.status and birthday_packages.status
  workshopStatus: { 'Draft': 'مسودة', 'Published': 'منشورة', 'Archived': 'مؤرشفة' },
  // workshops.skillLevel (option values are stored and compared, e.g. the badge colour)
  skillLevel:     { 'Beginner': 'مبتدئ', 'Intermediate': 'متوسط', 'Advanced': 'متقدم', 'All Levels': 'كل المستويات' },
  // birthday_packages.pricingType
  pricingType:    { 'Per child': 'للطفل', 'Per person': 'للشخص', 'Fixed price': 'سعر ثابت' },
  // checkStaffMemberAvailability().status, shown next to a staff name in dropdowns.
  // 'Available' is also reused for space options.
  staffAvailability: { 'Available': 'متاح', 'Busy': 'مشغول', 'Outside working hours': 'خارج ساعات العمل',
                       'On Leave': 'في إجازة', 'No schedule set': 'لا يوجد جدول محدد' },
  // staff.role: the console permission level. Compared elsewhere (isSuperAdmin), so display-only here.
  staffRole: { 'Super Admin': 'مدير عام', 'Admin': 'مسؤول', 'Staff': 'موظف' },
  // staff.status. 'On Leave' is worded the same as staffAvailability's 'On Leave'.
  staffStatus:    { 'Active': 'نشط', 'On Leave': 'في إجازة', 'Inactive': 'غير نشط', 'Former Staff': 'موظف سابق' },
  // Full weekday names, as stored on staff schedules (WEEKDAYS).
  weekday:        { 'Sunday': 'الأحد', 'Monday': 'الاثنين', 'Tuesday': 'الثلاثاء', 'Wednesday': 'الأربعاء',
                    'Thursday': 'الخميس', 'Friday': 'الجمعة', 'Saturday': 'السبت' },
  // StaffAssignment.type, shown as a badge on a staff member's profile.
  assignmentType: { 'Workshop Session': 'جلسة ورشة', 'Event': 'فعالية', 'Birthday': 'عيد ميلاد', 'Queue Duty': 'مناوبة الطابور' },
  // studio_resources.type (stored and compared)
  resourceType:   { 'Studio Room': 'قاعة استوديو', 'Table Station': 'محطة طاولة' }
};

/**
 * English display names that differ from the stored value. DISPLAY ONLY: the
 * piece status stays 'First Burn and Colored' in the data, the DB check, the SMS
 * gates and every comparison; staff just see it as "Kiln Time".
 */
const EN_LABELS: Partial<Record<keyof typeof LABELS, Record<string, string>>> = {
  pieceStatus: { 'First Burn and Colored': 'Kiln Time' }
};

export function enumLabel(group: keyof typeof LABELS, value: string, lang: Lang): string {
  if (lang !== 'ar') return EN_LABELS[group]?.[value] ?? value;
  return LABELS[group]?.[value] ?? value;
}
