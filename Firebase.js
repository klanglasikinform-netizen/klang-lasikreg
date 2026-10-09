rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // แก้อีเมลให้ตรงกับ ADMIN_EMAILS ในโค้ด (ตัวพิมพ์เล็กทั้งหมด)
    function isAdmin() {
      return request.auth != null
        && request.auth.token.email.lower() in ['klanglasik.inform@gmail.com.com'];
    }

    match /doctors/{id}    { allow read: if true; allow write: if isAdmin(); }
    match /schedule/{year} { allow read: if true; allow write: if isAdmin(); }

    match /appointments/{id} {
      // ผู้ป่วยสร้างนัดได้ แต่อ่าน แก้ไข หรือลบไม่ได้
      allow create: if request.resource.data.status == 'pending'
        && request.resource.data.name is string
        && request.resource.data.name.size() > 0
        && request.resource.data.name.size() <= 150
        && request.resource.data.age is number
        && request.resource.data.type in ['exam', 'combo'];
      allow read, update, delete: if isAdmin();
    }
  }
}
