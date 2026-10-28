/** One honest sentence about what the live view's scale ratio means (device pixels per source pixel). */
export function sharpnessVerdict(m: { scale: number }): { tone: "ok" | "warn" | "info"; text: string } {
  if (m.scale > 1.08)
    return {
      tone: "warn",
      text: `התמונה מוגדלת פי ${m.scale.toFixed(2)} על המסך — הגדלה בתוכנה לא מוסיפה פרטים. להגדלת פוקוס חד השתמשו בהגדלת המצלמה (EVF) או במצב 1:1.`,
    };
  if (m.scale >= 0.92) return { tone: "ok", text: "כל פיקסל של המקור מוצג כפיקסל אחד במסך — זו החדות המרבית שהמצלמה מספקת בתצוגה החיה." };
  return { tone: "info", text: `התצוגה מוקטנת (×${m.scale.toFixed(2)}) כדי להתאים למסך — חדה. מצב 1:1 מציג את הפרטים בגודל המלא.` };
}
