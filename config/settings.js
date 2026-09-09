const AppSetting = require("../models/AppSetting.js");

async function getSettingNumber(key, defaultValue = 0) {
  const row = await AppSetting.findOne({ where: { key } });
  if (!row) return Number(defaultValue);

  const n = Number(row.value);
  return Number.isFinite(n) ? n : Number(defaultValue);
}

async function getSettingString(key, defaultValue = "") {
  const row = await AppSetting.findOne({ where: { key } });
  if (!row || row.value === null || row.value === undefined) return String(defaultValue);
  return String(row.value);
}

async function updateAppSettingString(key, val) {
  if (val !== undefined && val !== null) {
    const strVal = String(val).trim();
    const [setting] = await AppSetting.findOrCreate({
      where: { key },
      defaults: { key, value: strVal },
    });
    setting.value = strVal;
    await setting.save();
    return strVal;
  }
  return null;
}

module.exports = {
  getSettingNumber,
  getSettingString,
  updateAppSettingString,
};
