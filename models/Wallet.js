import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

const Wallet = sequelize.define(
  "Wallet",
  {
    userId: { type: DataTypes.INTEGER, allowNull: false, unique: true },

    balance: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
    },
    lockedBalance: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
    },
    totalBalance: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
    },
    totalSpent: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    isUnlocked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  { timestamps: true }
);

export default Wallet;
