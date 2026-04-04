const TOKEN_KEY = 'student_token';
const STUDENT_KEY = 'student_profile';

function setSession(payload) {
  if (!payload || !payload.token || !payload.student) {
    return;
  }
  wx.setStorageSync(TOKEN_KEY, payload.token);
  wx.setStorageSync(STUDENT_KEY, payload.student);
}

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || '';
}

function getStudent() {
  return wx.getStorageSync(STUDENT_KEY) || null;
}

function setStudentProfile(student) {
  if (!student) {
    return;
  }
  wx.setStorageSync(STUDENT_KEY, student);
}

function clearSession() {
  wx.removeStorageSync(TOKEN_KEY);
  wx.removeStorageSync(STUDENT_KEY);
}

module.exports = {
  TOKEN_KEY,
  setSession,
  setStudentProfile,
  getToken,
  getStudent,
  clearSession,
};
