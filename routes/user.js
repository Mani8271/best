
// ========================= routes/users.js (FULL FILE) =========================
import express from "express";
import { Op } from "sequelize";
import bcrypt from "bcryptjs";

import User from "../models/User.js";
import auth from "../middleware/auth.js";
import isAdmin from "../middleware/isAdmin.js";
import { uploadUserDocs, getPublicPath } from "../config/upload.js";
import { sequelize } from "../config/db.js";
import Wallet from "../models/Wallet.js";
import WalletTransaction from "../models/WalletTransaction.js";
import BinaryNode from "../models/BinaryNode.js";
import Referral from "../models/Referral.js";
import ReferralLink from "../models/ReferralLink.js";

const router = express.Router();
/**
 * ✅ GET /api/users/me
 * Returns currently logged-in user details
 */
router.get("/me", auth, async (req, res) => {
  try {
    // Data is already fetched in auth middleware to reduce TTFB
    res.json({ user: req.user });
  } catch (err) {
    console.error("GET /api/users/me error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

/**
 * ✅ GET /api/users
 * Query:
 *   page=1&limit=10&search=mani&role=USER
 */
router.get("/", auth, isAdmin, async (req, res) => {
  try {
    const search = (req.query.search || "").trim();
    const role = (req.query.role || "").trim().toUpperCase();

    const where = {};

    if (role === "USER" || role === "ADMIN") where.role = role;

    if (search) {
      where[Op.or] = [
        { name: { [Op.like]: `${search}%` } },
        { userID: { [Op.like]: `${search}%` } },
      ];
    }

    const users = await User.findAll({
      where,
      attributes: [
        "id",
        "userID",
        "name",
        "email",
        "phone",
        "role",
        "userType",
        "password",
        "profilePic",
        "bankAccountNumber",
        "ifscCode",
        "accountHolderName",
        "panNumber",
        "upiId",
        "gender",
        "dateOfBirth",
        "activationDate",
        "bankPhoto",
        "panPhoto",
        "aadharPhoto",
        "bankName",
        "bankBranch",
        "bankAccountType",
        "adharNumber",
        "nomineeName",
        "nomineeRelation",
        "nomineePhone",
        "status",
        "createdAt",
        "updatedAt",
      ],
    });

    res.json({
      total: users.length,
      users,
    });
  } catch (err) {
    console.error("GET /api/users error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

/**
 * ✅ GET /api/users/:id
 */
router.get("/:id", auth, isAdmin, async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id, {
      attributes: [
        "id",
        "userID",
        "name",
        "email",
        "phone",
        "role",
        "userType",
        "password",
        "profilePic",
        "bankAccountNumber",
        "ifscCode",
        "accountHolderName",
        "panNumber",
        "upiId",
        "gender",
        "dateOfBirth",
        "activationDate",
        "bankPhoto",
        "panPhoto",
        "aadharPhoto",
        "bankName",
        "bankBranch",
        "bankAccountType",
        "adharNumber",
        "nomineeName",
        "nomineeRelation",
        "nomineePhone",
        "status",
        "createdAt",
        "updatedAt",
      ],
    });

    if (!user) return res.status(404).json({ msg: "User not found" });
    res.json(user);
  } catch (err) {
    console.error("GET /api/users/:id error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

/**
 * ✅ PUT /api/users/:id
 * Supports:
 * - multipart/form-data (to upload profilePic file)
 * - regular JSON (no file)
 *
 * Body: { name?, email?, phone?, role?, password?, userType?, profilePic(file) }
 */
router.put("/:id", auth, (req, res) => {
  uploadUserDocs(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ msg: err.message });

      const {
        name,
        email,
        phone,
        role,
        password,
        userType,
        bankAccountNumber,
        ifscCode,
        accountHolderName,
        panNumber,
        upiId,
        gender,
        dateOfBirth,
        bankName,
        bankBranch,
        bankAccountType,
        adharNumber,
        nomineeName,
        nomineeRelation,
        nomineePhone,
        status,
      } = req.body;

      const user = await User.findByPk(req.params.id);
      if (!user) return res.status(404).json({ msg: "User not found" });

      // Unique check for email/phone if changed
      if (email && email !== user.email) {
        const exists = await User.findOne({ where: { email } });
        if (exists) return res.status(400).json({ msg: "Email already exists" });
        user.email = email;
      }

      if (phone && phone !== user.phone) {
        const exists = await User.findOne({ where: { phone } });
        if (exists) return res.status(400).json({ msg: "Phone already exists" });
        user.phone = phone;
      }

      if (name) user.name = name;

      // userType update (optional)
      if (typeof userType !== "undefined" && userType !== null) {
        user.userType = userType;
      }

      // role update
      if (role) {
        const r = role.toString().toUpperCase();
        if (!["USER", "ADMIN", "MASTER", "STAFF"].includes(r)) {
          return res.status(400).json({ msg: "Invalid role" });
        }
        user.role = r;
      }

      // password update
      if (password) {
        user.password = password; // ⚠️ plain save
      }

      // bank details update
      if (bankAccountNumber !== undefined) user.bankAccountNumber = bankAccountNumber;
      if (ifscCode !== undefined) user.ifscCode = ifscCode;
      if (accountHolderName !== undefined) user.accountHolderName = accountHolderName;
      if (panNumber !== undefined) user.panNumber = panNumber;
      if (upiId !== undefined) user.upiId = upiId;

      // New Fields
      if (gender !== undefined) user.gender = gender;
      if (dateOfBirth !== undefined) user.dateOfBirth = dateOfBirth;
      if (bankName !== undefined) user.bankName = bankName;
      if (bankBranch !== undefined) user.bankBranch = bankBranch;
      if (bankAccountType !== undefined) user.bankAccountType = bankAccountType;
      if (adharNumber !== undefined) user.adharNumber = adharNumber;

      if (nomineeName !== undefined) user.nomineeName = nomineeName;
      if (nomineeRelation !== undefined) user.nomineeRelation = nomineeRelation;
      if (nomineePhone !== undefined) user.nomineePhone = nomineePhone;

      if (status !== undefined) {
        const s = status.toString().toUpperCase();
        if (!["ACTIVE", "INACTIVE"].includes(s)) {
          return res.status(400).json({ msg: "Invalid status (must be ACTIVE or INACTIVE)" });
        }
        user.status = s;
      }

      // profilePic update (only if file uploaded)
      if (req.files) {
        if (req.files.profilePic && req.files.profilePic[0]) {
          user.profilePic = getPublicPath(req.files.profilePic[0]);
        }
        if (req.files.bankPhoto && req.files.bankPhoto[0]) {
          user.bankPhoto = getPublicPath(req.files.bankPhoto[0]);
        }
        if (req.files.panPhoto && req.files.panPhoto[0]) {
          user.panPhoto = getPublicPath(req.files.panPhoto[0]);
        }
        if (req.files.aadharPhoto && req.files.aadharPhoto[0]) {
          user.aadharPhoto = getPublicPath(req.files.aadharPhoto[0]);
        }
      }

      await user.save();

      res.json({
        msg: "User updated",
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: user.role,
          userType: user.userType,
          profilePic: user.profilePic,
          bankAccountNumber: user.bankAccountNumber,
          ifscCode: user.ifscCode,
          accountHolderName: user.accountHolderName,
          panNumber: user.panNumber,
          upiId: user.upiId,
          gender: user.gender,
          dateOfBirth: user.dateOfBirth,
          activationDate: user.activationDate,
          bankPhoto: user.bankPhoto,
          panPhoto: user.panPhoto,
          aadharPhoto: user.aadharPhoto,
          bankName: user.bankName,
          bankBranch: user.bankBranch,
          bankAccountType: user.bankAccountType,
          adharNumber: user.adharNumber,
          nomineeName: user.nomineeName,
          nomineeRelation: user.nomineeRelation,
          nomineePhone: user.nomineePhone,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        },
      });
    } catch (err2) {
      console.error("PUT /api/users/:id error:", err2);

      // Sequelize unique constraint fallback
      if (err2?.name === "SequelizeUniqueConstraintError") {
        return res.status(400).json({ msg: "Email/Phone already exists" });
      }

      return res.status(500).json({ msg: "Server error" });
    }
  });
});
// ✅ POST /api/users/change-password
// Body: { oldPassword, newPassword }
router.post("/change-password", auth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      return res.status(400).json({ msg: "oldPassword and newPassword required" });
    }

    if (String(newPassword).length < 6) {
      return res.status(400).json({ msg: "New password must be at least 6 characters" });
    }

    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ msg: "User not found" });

    // ✅ plain verify
    if (String(oldPassword) !== String(user.password)) {
      return res.status(400).json({ msg: "Old password is incorrect" });
    }

    // ✅ prevent same password
    if (String(newPassword) === String(user.password)) {
      return res.status(400).json({ msg: "New password must be different" });
    }

    // ✅ update plain
    user.password = String(newPassword);
    await user.save();

    return res.json({ msg: "Password updated successfully" });
  } catch (err) {
    console.error("POST /api/users/change-password error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});



/**
 * ✅ DELETE /api/users/:id
 */
router.delete("/:id", auth, isAdmin, async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const user = await User.findByPk(req.params.id, { transaction: t });
    if (!user) {
      await t.rollback();
      return res.status(404).json({ msg: "User not found" });
    }

    // Safety: prevent admin deleting himself
    if (user.id === req.user.id) {
      await t.rollback();
      return res.status(400).json({ msg: "You cannot delete your own account" });
    }

    const userId = user.id;

    // 1. Delete wallet transactions first (FK -> Wallet)
    const wallet = await Wallet.findOne({ where: { userId }, transaction: t });
    if (wallet) {
      await WalletTransaction.destroy({ where: { walletId: wallet.id }, transaction: t });
      await wallet.destroy({ transaction: t });
    }

    // 2. Delete referral links
    await ReferralLink.destroy({ where: { sponsorId: userId }, transaction: t });

    // 3. Delete referrals (as sponsor or referred)
    await Referral.destroy({
      where: { [Op.or]: [{ sponsorId: userId }, { referredUserId: userId }] },
      transaction: t,
    });

    // 4. Delete binary node
    await BinaryNode.destroy({ where: { userId }, transaction: t });

    // 5. Finally delete user
    await user.destroy({ transaction: t });

    await t.commit();
    res.json({ msg: "User deleted successfully" });
  } catch (err) {
    await t.rollback();
    console.error("DELETE /api/users/:id error:", err);
    res.status(500).json({ msg: err.message || "Server error" });
  }
});



export default router;
