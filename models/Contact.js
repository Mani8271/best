import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

const Contact = sequelize.define(
    "Contact",
    {
        name: { type: DataTypes.STRING, allowNull: false },
        phone: { type: DataTypes.STRING, allowNull: false },
        message: { type: DataTypes.TEXT, allowNull: false },

        // Admin read tracking
        isRead: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false }
    },
    { timestamps: true }
);

export default Contact;
