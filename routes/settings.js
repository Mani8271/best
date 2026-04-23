// import express from "express";
// import auth from "../middleware/auth.js";
// import isAdmin from "../middleware/isAdmin.js";
// import AppSetting from "../models/AppSetting.js";

// const router = express.Router();

// // GET /api/settings/admin
// router.get("/admin", auth, async (req, res) => {
//   const rows = await AppSetting.findAll({ order: [["key", "ASC"]] });
//   res.json(rows);
// });

// // PUT /api/settings/admin
// // Body: { key:"WALLET_MIN_SPEND", value:"3000" }
// router.post("/admin", auth,async (req, res) => {
//   const { key, value } = req.body;
//   if (!key) return res.status(400).json({ msg: "key required" });

//   const v = String(value ?? "").trim();
//   if (!v) return res.status(400).json({ msg: "value required" });

//   const [row] = await AppSetting.findOrCreate({
//     where: { key },
//     defaults: { value: v },
//   });

//   if (row.value !== v) {
//     row.value = v;
//     await row.save();
//   }

//   res.json({ msg: "Saved", key: row.key, value: row.value });
// });

// // export default router;
// import express from "express";
// import auth from "../middleware/auth.js";
// import isAdmin from "../middleware/isAdmin.js";
// import AppSetting from "../models/AppSetting.js";

// const router = express.Router();

// router.get("/", auth,  async (req, res) => {
//   const rows = await AppSetting.findAll({ order: [["key", "ASC"]] });
//   res.json(rows);
// });

// router.put("/", auth, isAdmin, async (req, res) => {
//   const { key, value } = req.body;
//   if (!key) return res.status(400).json({ msg: "key required" });

//   const [row, created] = await AppSetting.findOrCreate({
//     where: { key },
//     defaults: { value: String(value ?? "") },
//   });

//   if (!created) {
//     row.value = String(value ?? "");
//     await row.save();
//   }

//   res.json({ msg: "Saved", setting: row });
// });

// export default router;

import express from "express";
import auth from "../middleware/auth.js";
import AppSetting from "../models/AppSetting.js";

const router = express.Router();

/**
 * ✅ GET ALL SETTINGS
 * GET /api/settings
 */
router.get("/", auth, async (req, res) => {
  try {
    const rows = await AppSetting.findAll({ order: [["key", "ASC"]] });
    return res.json(rows);
  } catch (err) {
    console.error("GET /api/settings error:", err);
    return res.status(500).json({ msg: "Server error", err: err.message });
  }
});

/**
 * ✅ CREATE SETTING (WITH key)
 * POST /api/settings
 * Body: { key: "MIN_SPEND_UNLOCK", value: "30000" }
 */
router.post("/", auth, async (req, res) => {
  try {
    const { key, value } = req.body;

    if (!key || String(key).trim() === "")
      return res.status(400).json({ msg: "key required" });

    if (value === undefined || String(value).trim() === "")
      return res.status(400).json({ msg: "value required" });

    const cleanKey = String(key).trim().toUpperCase();
    const cleanValue = String(value).trim();

    // prevent duplicates
    const exists = await AppSetting.findOne({ where: { key: cleanKey } });
    if (exists) {
      return res.status(400).json({ msg: "key already exists", key: cleanKey });
    }

    const row = await AppSetting.create({
      key: cleanKey,
      value: cleanValue,
    });

    return res.status(201).json({ msg: "Created", setting: row });
  } catch (err) {
    console.error("POST /api/settings error:", err);
    return res.status(500).json({ msg: "Server error", err: err.message });
  }
});

/**
 * ✅ UPDATE SETTING BY KEY
 * PUT /api/settings/:key
 * Body: { value: "50000" }
 */
router.put("/:key", auth, async (req, res) => {
  try {
    const { value } = req.body;
    if (value === undefined || String(value).trim() === "")
      return res.status(400).json({ msg: "value required" });

    const cleanKey = String(req.params.key).trim().toUpperCase();

    const row = await AppSetting.findOne({ where: { key: cleanKey } });
    if (!row) return res.status(404).json({ msg: "Setting not found", key: cleanKey });

    row.value = String(value).trim();
    await row.save();

    return res.json({ msg: "Updated", setting: row });
  } catch (err) {
    console.error("PUT /api/settings/:key error:", err);
    return res.status(500).json({ msg: "Server error", err: err.message });
  }
});

/**
 * ✅ DELETE SETTING BY KEY
 * DELETE /api/settings/:key
 */
router.delete("/:key", auth, async (req, res) => {
  try {
    const cleanKey = String(req.params.key).trim().toUpperCase();

    const row = await AppSetting.findOne({ where: { key: cleanKey } });
    if (!row) return res.status(404).json({ msg: "Setting not found", key: cleanKey });

    await row.destroy();
    return res.json({ msg: "Deleted", key: cleanKey });
  } catch (err) {
    console.error("DELETE /api/settings/:key error:", err);
    return res.status(500).json({ msg: "Server error", err: err.message });
  }
});

export default router;
