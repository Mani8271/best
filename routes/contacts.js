import express from "express";
import { Op } from "sequelize";
import Contact from "../models/Contact.js";
import auth from "../middleware/auth.js";
import isAdmin from "../middleware/isAdmin.js";

const router = express.Router();

/**
 * ✅ POST /api/contacts
 * Public: Submit contact us form
 */
router.post("/", async (req, res) => {
    try {
        const { name, phone, message } = req.body;

        if (!name || !phone || !message) {
            return res.status(400).json({ msg: "Name, phone, and message are required fields" });
        }

        const contact = await Contact.create({
            name: name.toString().trim(),
            phone: phone.toString().trim(),
            message: message.toString().trim(),
        });

        res.status(201).json({ msg: "Message sent successfully", contact });
    } catch (err) {
        console.error("POST /api/contacts error:", err);
        res.status(500).json({ msg: "Server error" });
    }
});

/**
 * ✅ ADMIN: GET /api/contacts/admin/unread-count
 * Returns only the number of unread messages for dashboard badges
 */
router.get("/admin/unread-count", auth, isAdmin, async (req, res) => {
    try {
        const count = await Contact.count({ where: { isRead: false } });
        res.json({ unreadCount: count });
    } catch (err) {
        console.error("GET /api/contacts/admin/unread-count error:", err);
        res.status(500).json({ msg: "Server error" });
    }
});

/**
 * ✅ ADMIN: GET /api/contacts/admin/all
 * Query optional: search=..., isRead=true/false
 */
router.get("/admin/all", auth, isAdmin, async (req, res) => {
    try {
        const search = (req.query.search || "").trim();
        const isReadQuery = req.query.isRead;

        const where = {};

        if (isReadQuery !== undefined) {
            where.isRead = String(isReadQuery).toLowerCase() === "true";
        }

        if (search) {
            where[Op.or] = [
                { name: { [Op.like]: `%${search}%` } },
                { phone: { [Op.like]: `%${search}%` } },
                { message: { [Op.like]: `%${search}%` } },
            ];
        }

        const [contacts, unreadCount] = await Promise.all([
            Contact.findAll({
                where,
                order: [["createdAt", "DESC"]],
            }),
            Contact.count({ where: { isRead: false } }),
        ]);

        res.json({ total: contacts.length, unreadCount, contacts });
    } catch (err) {
        console.error("GET /api/contacts/admin/all error:", err);
        res.status(500).json({ msg: "Server error" });
    }
});

/**
 * ✅ ADMIN: PATCH /api/contacts/admin/:id/read
 * Mark a contact submission as read
 */
router.patch("/admin/:id/read", auth, isAdmin, async (req, res) => {
    try {
        const contact = await Contact.findByPk(req.params.id);
        if (!contact) return res.status(404).json({ msg: "Contact not found" });

        contact.isRead = true;
        await contact.save();

        res.json({ msg: "Marked as read", contact });
    } catch (err) {
        console.error("PATCH /api/contacts/admin/:id/read error:", err);
        res.status(500).json({ msg: "Server error" });
    }
});

/**
 * ✅ ADMIN: PATCH /api/contacts/admin/read-all
 * Mark ALL contact submissions as read
 */
router.patch("/admin/read-all", auth, isAdmin, async (req, res) => {
    try {
        await Contact.update({ isRead: true }, { where: { isRead: false } });
        res.json({ msg: "All messages marked as read" });
    } catch (err) {
        console.error("PATCH /api/contacts/admin/read-all error:", err);
        res.status(500).json({ msg: "Server error" });
    }
});

export default router;
