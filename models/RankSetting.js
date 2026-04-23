import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

const RankSetting = sequelize.define(
  "RankSetting",
  {
    pairsRequired: { type: DataTypes.INTEGER, allowNull: false, unique: true }, // 30
    cashReward: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    giftName: { type: DataTypes.STRING(120), allowNull: true }, // "Smart Watch"
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { timestamps: true }
);

export default RankSetting;
