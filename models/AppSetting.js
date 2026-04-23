const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db.js");

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

module.exports = AppSetting;
