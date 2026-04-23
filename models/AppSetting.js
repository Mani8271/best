import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

const AppSetting = sequelize.define(
  "AppSetting",
  {
    key: { type: DataTypes.STRING(80), allowNull: false, unique: true },
    value: { type: DataTypes.STRING(255), allowNull: false },
  },
  {
    timestamps: true,
    tableName: "AppSettings",
    freezeTableName: true
  }
);

export default AppSetting;
