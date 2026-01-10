
export function getDate() {
    const currentDate = new Date();
    const date = `${(currentDate.getMonth() + 1)
      .toString()
      .padStart(2, "0")}/${currentDate
      .getDate()
      .toString()
      .padStart(2, "0")}/${currentDate.getFullYear()}`;
    const time = `${currentDate
      .getHours()
      .toString()
      .padStart(2, "0")}:${currentDate.getMinutes().toString().padStart(2, "0")}`;
    return `${time}, ${date}`;
  }