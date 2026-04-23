import express from "express";
import { Op } from "sequelize";
import Address from "../models/Address.js";
import User from "../models/User.js";
import auth from "../middleware/auth.js";
import isAdmin from "../middleware/isAdmin.js";

const router = express.Router();

/**
 * ✅ POST /api/addresses
 * Body:
 * {
 *   label,
 *   pincode,
 *   house,
 * *   area,
 *   state,
 *   receiverFirstName,
 *   receiverLastName?,
 *   receiverPhone,
 *   isDefault? (true/false)
 * }
 */
router.post("/", auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const {
      label = "Home",
      pincode,
      house,
      area,
      state,
      street,
      village,
      mandal,
      panchayati,
      district,
      receiverFirstName,
      receiverLastName,
      receiverPhone,
      isDefault = false,
    } = req.body;

    if (!label || !pincode || !house || !area || !state || !receiverFirstName || !receiverPhone) {
      return res.status(400).json({ msg: "Required fields missing" });
    }

    const created = await Address.create({
      userId,
      label: label.toString().trim(),
      pincode: pincode.toString().trim(),
      house: house.toString().trim(),
      area: area.toString().trim(),
      state: state.toString().trim(),
      street: street ? street.toString().trim() : null,
      village: village ? village.toString().trim() : null,
      mandal: mandal ? mandal.toString().trim() : null,
      panchayati: panchayati ? panchayati.toString().trim() : null,
      district: district ? district.toString().trim() : null,
      receiverFirstName: receiverFirstName.toString().trim(),
      receiverLastName: receiverLastName ? receiverLastName.toString().trim() : null,
      receiverPhone: receiverPhone.toString().trim(),
      isDefault: !!isDefault,
      isActive: true,
    });

    // if first address OR isDefault => make default
    const count = await Address.count({ where: { userId, isActive: true } });
    if (count === 1 || isDefault) {
      await Address.update({ isDefault: false }, { where: { userId } });
      await Address.update({ isDefault: true }, { where: { id: created.id, userId } });
    }

    const address = await Address.findOne({ where: { id: created.id, userId } });
    return res.status(201).json({ msg: "Address added", address });
  } catch (err) {
    console.error("POST /api/addresses error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

/**
 * ✅ GET /api/addresses
 * Query (optional):
 *   search=...&label=Home
 */
router.get("/", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const search = (req.query.search || "").trim();
    const label = (req.query.label || "").trim();

    const where = { userId, isActive: true };

    if (label) where.label = label;

    if (search) {
      where[Op.or] = [
        { label: { [Op.like]: `%${search}%` } },
        { pincode: { [Op.like]: `%${search}%` } },
        { house: { [Op.like]: `%${search}%` } },
        { area: { [Op.like]: `%${search}%` } },
        { state: { [Op.like]: `%${search}%` } },
        { street: { [Op.like]: `%${search}%` } },
        { village: { [Op.like]: `%${search}%` } },
        { mandal: { [Op.like]: `%${search}%` } },
        { panchayati: { [Op.like]: `%${search}%` } },
        { district: { [Op.like]: `%${search}%` } },
        { receiverFirstName: { [Op.like]: `%${search}%` } },
        { receiverLastName: { [Op.like]: `%${search}%` } },
        { receiverPhone: { [Op.like]: `%${search}%` } },
      ];
    }

    const addresses = await Address.findAll({
      where,
      order: [["isDefault", "DESC"], ["createdAt", "DESC"]],
    });

    res.json({ total: addresses.length, addresses });
  } catch (err) {
    console.error("GET /api/addresses error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

/**
 * ✅ GET /api/addresses/default
 */
router.get("/default", auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const address = await Address.findOne({
      where: { userId, isActive: true },
      order: [["isDefault", "DESC"], ["createdAt", "DESC"]],
    });

    if (!address) return res.status(404).json({ msg: "No address found" });
    res.json(address);
  } catch (err) {
    console.error("GET /api/addresses/default error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

/**
 * ✅ GET /api/addresses/:id
 */
router.get("/:id", auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const address = await Address.findOne({
      where: { id: req.params.id, userId, isActive: true },
    });

    if (!address) return res.status(404).json({ msg: "Address not found" });
    res.json(address);
  } catch (err) {
    console.error("GET /api/addresses/:id error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});
/**
 * ✅ ADMIN: GET /api/addresses/admin/:id
 * returns single address by id (no user restriction)
 */
router.get("/admin/:id", auth, isAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const address = await Address.findOne({
      where: { id },
      include: [
        {
          model: User,
          as: "user",
          attributes: ["id", "name", "email", "phone", "role"],
          required: false,
        },
      ],
    });

    if (!address) return res.status(404).json({ msg: "Address not found" });
    res.json({ address });
  } catch (err) {
    console.error("GET /api/addresses/admin/:id error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});


/**
 * ✅ PUT /api/addresses/:id
 */
router.put("/:id", auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const address = await Address.findOne({ where: { id: req.params.id, userId } });
    if (!address) return res.status(404).json({ msg: "Address not found" });

    const updatable = [
      "label",
      "pincode",
      "house",
      "area",
      "state",
      "street",
      "village",
      "mandal",
      "panchayati",
      "district",
      "receiverFirstName",
      "receiverLastName",
      "receiverPhone",
      "isDefault",
      "isActive",
    ];

    updatable.forEach((key) => {
      if (req.body[key] !== undefined) address[key] = req.body[key];
    });

    await address.save();

    // if isDefault true -> unset others and set this
    if (req.body.isDefault === true) {
      await Address.update({ isDefault: false }, { where: { userId } });
      await Address.update({ isDefault: true }, { where: { id: address.id, userId } });
    }

    const updated = await Address.findOne({ where: { id: address.id, userId } });
    res.json({ msg: "Address updated", address: updated });
  } catch (err) {
    console.error("PUT /api/addresses/:id error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

/**
 * ✅ PATCH /api/addresses/:id/default
 */
router.patch("/:id/default", auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const address = await Address.findOne({
      where: { id: req.params.id, userId, isActive: true },
    });

    if (!address) return res.status(404).json({ msg: "Address not found" });

    await Address.update({ isDefault: false }, { where: { userId } });
    await Address.update({ isDefault: true }, { where: { id: address.id, userId } });

    res.json({ msg: "Default address set" });
  } catch (err) {
    console.error("PATCH /api/addresses/:id/default error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

/**
 * ✅ DELETE /api/addresses/:id
 * Soft delete
 */
router.delete("/:id", auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const address = await Address.findOne({ where: { id: req.params.id, userId } });
    if (!address) return res.status(404).json({ msg: "Address not found" });

    const wasDefault = address.isDefault === true;

    address.isActive = false;
    address.isDefault = false;
    await address.save();

    // if default deleted -> set latest as default
    if (wasDefault) {
      const next = await Address.findOne({
        where: { userId, isActive: true },
        order: [["createdAt", "DESC"]],
      });
      if (next) {
        await Address.update({ isDefault: false }, { where: { userId } });
        await Address.update({ isDefault: true }, { where: { id: next.id, userId } });
      }
    }

    res.json({ msg: "Address deleted" });
  } catch (err) {
    console.error("DELETE /api/addresses/:id error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

/**
 * ✅ ADMIN: GET /api/addresses/admin/all
 * Query optional:
 *   search=...
 *   label=Home
 *   userId=5
 *   isActive=true/false   (default true)
 */
/**
 * ✅ ADMIN: GET /api/addresses/admin/all
 * Query optional:
 *   search=...
 *   label=Home
 *   userId=5
 *   isActive=true/false (default true)
 *
 * ✅ search will match:
 *   - address fields: label, pincode, house, area, state, receiver..., phone
 *   - user fields: name, email, phone
 */
router.get("/admin/all", auth, isAdmin, async (req, res) => {
  try {
    const search = (req.query.search || "").trim();
    const label = (req.query.label || "").trim();
    const userId = req.query.userId ? Number(req.query.userId) : null;

    const isActiveQuery = req.query.isActive;
    const isActive =
      isActiveQuery === undefined
        ? true
        : String(isActiveQuery).toLowerCase() === "true";

    const where = { isActive };

    if (label) where.label = label;
    if (userId) where.userId = userId;

    const include = [
      {
        model: User,
        as: "user",
        attributes: ["id", "name", "email", "phone", "role"],
        required: false,
      },
    ];

    // ✅ Search on Address fields + User fields
    if (search) {
      where[Op.or] = [
        { label: { [Op.like]: `%${search}%` } },
        { pincode: { [Op.like]: `%${search}%` } },
        { house: { [Op.like]: `%${search}%` } },
        { area: { [Op.like]: `%${search}%` } },
        { state: { [Op.like]: `%${search}%` } },
        { street: { [Op.like]: `%${search}%` } },
        { village: { [Op.like]: `%${search}%` } },
        { mandal: { [Op.like]: `%${search}%` } },
        { panchayati: { [Op.like]: `%${search}%` } },
        { district: { [Op.like]: `%${search}%` } },
        { receiverFirstName: { [Op.like]: `%${search}%` } },
        { receiverLastName: { [Op.like]: `%${search}%` } },
        { receiverPhone: { [Op.like]: `%${search}%` } },

        // ✅ user search (works because include is joined)
        { "$user.name$": { [Op.like]: `%${search}%` } },
        { "$user.email$": { [Op.like]: `%${search}%` } },
        { "$user.phone$": { [Op.like]: `%${search}%` } },
      ];
    }

    const addresses = await Address.findAll({
      where,
      include,
      order: [["createdAt", "DESC"]],
    });

    res.json({ total: addresses.length, addresses });
  } catch (err) {
    console.error("GET /api/addresses/admin/all error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});


/**
 * ✅ ADMIN: GET /api/addresses/admin/user/:userId
 * Get single user addresses
 */
router.get("/admin/user/:userId", auth, isAdmin, async (req, res) => {
  try {
    const userId = Number(req.params.userId);

    const addresses = await Address.findAll({
      where: { userId, isActive: true },
      order: [["isDefault", "DESC"], ["createdAt", "DESC"]],
    });

    res.json({ total: addresses.length, addresses });
  } catch (err) {
    console.error("GET /api/addresses/admin/user/:userId error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});


export default router;
