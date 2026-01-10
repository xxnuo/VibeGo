package handler

import (
	"github.com/gin-gonic/gin"
)

type Response struct {
	Success bool   `json:"success"`
	Data    any    `json:"data,omitempty"`
	Error   string `json:"error,omitempty"`
}

func OK(c *gin.Context, data any) {
	c.JSON(200, Response{Success: true, Data: data})
}

func Created(c *gin.Context, data any) {
	c.JSON(201, Response{Success: true, Data: data})
}

func BadRequest(c *gin.Context, err string) {
	c.JSON(400, Response{Success: false, Error: err})
}

func NotFound(c *gin.Context, err string) {
	c.JSON(404, Response{Success: false, Error: err})
}

func Conflict(c *gin.Context, err string) {
	c.JSON(409, Response{Success: false, Error: err})
}

func ServerError(c *gin.Context, err string) {
	c.JSON(500, Response{Success: false, Error: err})
}

func Unauthorized(c *gin.Context, err string) {
	c.JSON(401, Response{Success: false, Error: err})
}

func TooManyRequests(c *gin.Context, err string) {
	c.JSON(429, Response{Success: false, Error: err})
}

type Pagination struct {
	Page     int   `json:"page"`
	PageSize int   `json:"page_size"`
	Total    int64 `json:"total"`
}

type PaginatedResponse struct {
	Success    bool       `json:"success"`
	Data       any        `json:"data,omitempty"`
	Pagination Pagination `json:"pagination,omitempty"`
	Error      string     `json:"error,omitempty"`
}

func OKPaginated(c *gin.Context, data any, page, pageSize int, total int64) {
	c.JSON(200, PaginatedResponse{
		Success:    true,
		Data:       data,
		Pagination: Pagination{Page: page, PageSize: pageSize, Total: total},
	})
}
